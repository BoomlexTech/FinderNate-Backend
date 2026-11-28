import admin, { getMessaging } from '../config/firebase-admin.config.js';
import AppRelease from '../models/appRelease.models.js';
import UserDevice from '../models/userDevice.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { dropDeadToken, isDeadTokenError } from '../services/pushTargets.service.js';
import {
    PLAY_STORE_URL,
    compareVersions,
    needsUpdate,
    parseVersion,
    updateNotificationText
} from '../utils/appVersion.utils.js';

/**
 * "A new version is available" (client list, item 14).
 *
 * An admin announces a version once it is live on Google Play. Every Android
 * phone on an older version gets a push; tapping it opens the app's Play Store
 * page. The app also asks GET /meta/app-version when it opens and shows its own
 * notice, so a phone with notifications muted still finds out.
 *
 * It is announced by a person and not read from the Play Store by this server
 * on purpose: a version is on the internal testing track, and in Google's
 * review, well before the public can install it. Telling everyone to update
 * to a version Google Play will not give them yet is worse than telling them a
 * little late.
 */

const SEND_BATCH = 200;
/** Stops a double click from pushing the same version to every phone twice. */
const RESEND_GUARD_MS = 10 * 60 * 1000;

const latestRelease = (platform = 'android') =>
    AppRelease.findOne({ platform }).sort({ announcedAt: -1 }).lean();

/**
 * One FCM token per Android phone that should hear about `version`.
 *
 * A phone holding several accounts has one device row per account, all with
 * the same token; it gets one push, and none at all if any of those rows says
 * it already runs this version or a newer one. Phones on a build from before
 * the device register (only `User.fcmToken`) have never reported a version, so
 * they are older than anything announced now.
 */
export const collectUpdateTokens = async (version) => {
    // token -> { userId, upToDate }
    const phones = new Map();

    const devices = UserDevice.find({ platform: 'android' }).select('userId token appVersion').lean().cursor();
    for await (const device of devices) {
        if (!device.token) continue;
        const upToDate = !needsUpdate(device.appVersion, version);
        const known = phones.get(device.token);
        phones.set(device.token, {
            userId: known?.userId || String(device.userId),
            upToDate: Boolean(known?.upToDate) || upToDate
        });
    }

    const legacyUsers = User.find({ fcmToken: { $nin: [null, ''] } }).select('fcmToken').lean().cursor();
    for await (const user of legacyUsers) {
        if (!phones.has(user.fcmToken)) phones.set(user.fcmToken, { userId: String(user._id), upToDate: false });
    }

    return [...phones.entries()]
        .filter(([, phone]) => !phone.upToDate)
        .map(([token, phone]) => ({ token, userId: phone.userId }));
};

/** Sends the push. Never throws: a dead token must not fail the announcement. */
const sendUpdatePush = async ({ version, notes }) => {
    if (!admin.apps.length) return { sent: 0, phones: 0, pushConfigured: false };

    const targets = await collectUpdateTokens(version);
    const { title, body } = updateNotificationText(version, notes);
    const messaging = getMessaging();
    let sent = 0;

    for (let i = 0; i < targets.length; i += SEND_BATCH) {
        await Promise.allSettled(targets.slice(i, i + SEND_BATCH).map(async ({ token, userId }) => {
            try {
                await messaging.send({
                    token,
                    // A `notification` block, so Android itself shows it even
                    // when the app is not running (see pushDelivery.service.js).
                    notification: { title, body },
                    // `type` is what the app's tap handler switches on; `url`
                    // is where it goes.
                    data: { type: 'app_update', version: String(version), url: PLAY_STORE_URL },
                    android: {
                        priority: 'high',
                        notification: {
                            // The general channel, which every installed build
                            // already has. A channel only new builds create
                            // would be dropped by exactly the phones this is for.
                            channelId: 'follows',
                            priority: 'default',
                            defaultVibrateTimings: true,
                            sound: 'default'
                        }
                    }
                });
                sent += 1;
            } catch (error) {
                if (isDeadTokenError(error)) await dropDeadToken(userId, token);
                else console.warn(`[app-update] push failed: ${error?.message}`);
            }
        }));
    }

    return { sent, phones: targets.length, pushConfigured: true };
};

const publicRelease = (release) => (release ? {
    version: release.version,
    notes: release.notes || '',
    pushSent: release.pushSent || 0,
    announcedAt: release.announcedAt
} : null);

/**
 * GET /api/v1/meta/app-version?platform=android&version=4.9.32   (public)
 *
 * `updateAvailable` is answered only when the caller says which version it
 * runs; the app sends its own.
 */
export const getAppVersion = asyncHandler(async (req, res) => {
    const platform = req.query.platform === 'ios' ? 'ios' : 'android';
    const installed = req.query.version;
    const latest = await latestRelease(platform);

    return res.status(200).json(new ApiResponse(200, {
        platform,
        latestVersion: latest?.version || null,
        notes: latest?.notes || '',
        updateUrl: platform === 'android' ? PLAY_STORE_URL : null,
        updateAvailable: Boolean(
            latest && parseVersion(installed) && compareVersions(installed, latest.version) < 0
        )
    }, 'OK'));
});

/** GET /api/v1/admin/app-update */
export const adminGetAppUpdate = asyncHandler(async (req, res) => {
    const [history, androidTokens] = await Promise.all([
        AppRelease.find({ platform: 'android' }).sort({ announcedAt: -1 }).limit(10).lean(),
        UserDevice.distinct('token', { platform: 'android' })
    ]);

    return res.status(200).json(new ApiResponse(200, {
        latest: publicRelease(history[0]),
        history: history.map(publicRelease),
        androidPhones: androidTokens.length,
        pushConfigured: admin.apps.length > 0,
        updateUrl: PLAY_STORE_URL
    }, 'OK'));
});

/**
 * POST /api/v1/admin/app-update   { version, notes?, notify? }
 *
 * `notify: false` only records the version (the app's own notice still shows
 * it); the default sends the push as well.
 */
export const adminAnnounceAppUpdate = asyncHandler(async (req, res) => {
    const version = String(req.body?.version || '').trim().replace(/^v/i, '').split('+')[0];
    if (!parseVersion(version)) {
        throw new ApiError(400, 'Enter the version as numbers and dots, for example 4.9.33');
    }
    const notes = String(req.body?.notes || '').trim().slice(0, 200);
    const notify = req.body?.notify !== false;

    const latest = await latestRelease('android');
    if (latest && compareVersions(version, latest.version) < 0) {
        throw new ApiError(400, `Version ${latest.version} has already been announced. Enter that version or a newer one.`);
    }
    if (
        notify && latest && compareVersions(version, latest.version) === 0 && latest.pushSent > 0 &&
        Date.now() - new Date(latest.announcedAt).getTime() < RESEND_GUARD_MS
    ) {
        throw new ApiError(409, `The notification for version ${version} was sent a few minutes ago. Wait a little before sending it again.`);
    }

    const result = notify
        ? await sendUpdatePush({ version, notes })
        : { sent: 0, phones: 0, pushConfigured: admin.apps.length > 0 };

    const release = await AppRelease.create({
        platform: 'android',
        version,
        notes,
        pushSent: result.sent,
        announcedBy: req.admin?._id || null
    });

    try {
        await req.admin?.logActivity?.(
            'app_update_announced',
            'system',
            String(release._id),
            `Announced app version ${version}${notify ? `, notification sent to ${result.sent} phone(s)` : ' (no notification)'}`
        );
    } catch { /* the log is not what was asked for */ }

    const message = !notify
        ? `Version ${version} saved. No notification was sent.`
        : !result.pushConfigured
            ? `Version ${version} saved, but push notifications are not set up on this server, so nothing was sent.`
            : `Version ${version} announced. Notification sent to ${result.sent} of ${result.phones} phone(s) on an older version.`;

    return res.status(201).json(new ApiResponse(201, {
        release: publicRelease(release),
        sent: result.sent,
        phones: result.phones,
        pushConfigured: result.pushConfigured
    }, message));
});
