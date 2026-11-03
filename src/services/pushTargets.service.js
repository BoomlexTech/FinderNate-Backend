import admin, { getMessaging } from '../config/firebase-admin.config.js';
import { User } from '../models/user.models.js';
import UserDevice from '../models/userDevice.models.js';

/**
 * Who to push to, across every device of every recipient (Phase 3 #25).
 *
 * Reads the new device register and the old single `User.fcmToken` (still
 * written by older app versions), and returns one entry per (account, token).
 * `sharedDevice` is true when the same phone holds more than one signed-in
 * account, so the notification can say which account it's for.
 */
export const getPushTargets = async (userIds) => {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
    if (!ids.length) return [];

    const [users, devices] = await Promise.all([
        User.find({ _id: { $in: ids } }).select('username fcmToken').lean(),
        UserDevice.find({ userId: { $in: ids }, platform: { $ne: 'web' } }).select('userId token').lean(),
    ]);
    const usernames = new Map(users.map((u) => [String(u._id), u.username]));

    const seen = new Set();
    const targets = [];
    const add = (userId, token, source) => {
        if (!token) return;
        const key = `${userId}|${token}`;
        if (seen.has(key)) return;
        seen.add(key);
        targets.push({ userId, token, source, username: usernames.get(userId) || '' });
    };
    devices.forEach((d) => add(String(d.userId), d.token, 'device'));
    users.forEach((u) => add(String(u._id), u.fcmToken, 'legacy'));

    if (!targets.length) return targets;

    // How many accounts each token holds, including recipients' other accounts.
    const tokens = [...new Set(targets.map((t) => t.token))];
    const counts = await UserDevice.aggregate([
        { $match: { token: { $in: tokens } } },
        { $group: { _id: '$token', n: { $sum: 1 } } },
    ]);
    const perToken = new Map(counts.map((c) => [c._id, c.n]));
    return targets.map((t) => ({ ...t, sharedDevice: (perToken.get(t.token) || 0) > 1 }));
};

const isDeadTokenError = (error) =>
    error?.code === 'messaging/registration-token-not-registered' ||
    error?.code === 'messaging/invalid-registration-token' ||
    error?.code === 'messaging/invalid-argument' ||
    error?.message?.includes('Requested entity was not found') ||
    error?.message?.includes('not a valid FCM registration token');

/** Removes a token that Firebase says is dead, from both registers. */
export const dropDeadToken = async (userId, token) => {
    await Promise.allSettled([
        UserDevice.deleteMany({ token }),
        User.updateMany({ fcmToken: token }, { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } }),
    ]);
};

const stringifyData = (data = {}) =>
    Object.entries(data).reduce((acc, [key, value]) => {
        if (value === null || value === undefined) return acc;
        acc[key] = String(value);
        return acc;
    }, {});

const CHANNEL_BY_TYPE = {
    message: 'messages',
    incoming_call: 'calls',
    call_ended: 'calls',
    call_accepted: 'calls',
    call_declined: 'calls',
    subscription: 'subscription',
    like: 'likes',
    unlike: 'likes',
    comment: 'comments',
};
const HIGH_PRIORITY = new Set(['message', 'incoming_call', 'call_ended', 'call_accepted', 'call_declined']);

/** Adds "· @username" to the title when the phone holds several accounts. */
export const titleFor = (title, target) =>
    target?.sharedDevice && target.username ? `${title} · @${target.username}` : title;

/**
 * One FCM message per target. `accountId` and `accountUsername` are always in
 * the data, so the app can open the right account when the push is tapped.
 * `dataOnly` sends without a tray notification (calls use their own UI).
 */
export const sendFcmToTargets = async (targets, { title, body, type, data = {}, dataOnly = false } = {}) => {
    if (!targets?.length || !admin.apps.length) return { sent: 0 };
    const messaging = getMessaging();
    let sent = 0;
    await Promise.allSettled(targets.map(async (t) => {
        const fullData = stringifyData({ ...data, type, accountId: t.userId, accountUsername: t.username });
        const shownTitle = titleFor(title, t);
        const message = {
            token: t.token,
            data: dataOnly ? { ...fullData, title: shownTitle, body: body || '' } : fullData,
            android: { priority: 'high' },
            apns: { payload: { aps: { contentAvailable: true, sound: 'default', ...(HIGH_PRIORITY.has(type) ? { badge: 1 } : {}) } } },
        };
        if (!dataOnly) {
            message.notification = { title: shownTitle, body };
            message.android.notification = {
                channelId: CHANNEL_BY_TYPE[type] || 'follows',
                priority: HIGH_PRIORITY.has(type) ? 'high' : 'default',
                defaultVibrateTimings: true,
                sound: 'default',
            };
            message.apns.payload.aps.alert = { title: shownTitle, body };
        }
        try {
            await messaging.send(message);
            sent += 1;
        } catch (error) {
            if (isDeadTokenError(error)) await dropDeadToken(t.userId, t.token);
            else console.warn(`[push] FCM send failed for ${t.userId}: ${error?.message}`);
        }
    }));
    return { sent };
};
