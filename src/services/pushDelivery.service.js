import admin, { getMessaging } from "../config/firebase-admin.config.js";
import { User } from "../models/user.models.js";
import { sendPushNotification as sendWebPush } from "../controllers/pushNotification.controllers.js";

/**
 * One place that turns "this user should be told about X" into an actual push.
 *
 * Before this existed the only event that ever reached FCM was a chat message
 * (chat/message.controllers.js) and a call (call.controllers.js). Everything
 * else — follows, contact requests, business verification — was written to the
 * Notification collection and emitted on the Socket.IO `notification` channel
 * and nothing more. The mobile client turns that socket event into a LOCAL
 * notification, which means it can only ever fire while the app is running and
 * connected. That is exactly the reported symptom "push notifications only
 * arrive after the app has been opened once": for those events there was no
 * push at all, only an in-process socket message.
 *
 * Two delivery paths, because the two clients register differently:
 *   - FCM, keyed on User.fcmToken, is the MOBILE app.
 *   - web-push/VAPID, keyed on the PushSubscription collection, is the WEBSITE.
 * A user can legitimately have both; neither is a substitute for the other.
 */

/**
 * Android notification channels the mobile app creates at startup
 * (NotificationServices._createNotificationChannels in the Flutter app).
 *
 * Getting this right is not cosmetic. The "calls" channel is configured with a
 * ringtone (RawResourceAndroidNotificationSound('call_ringtone')) and high
 * importance, so routing a follow or a contact request onto it would make the
 * device ring as if someone were calling. Anything that is not a message and
 * not a call belongs on a normal-importance social channel.
 */
const ANDROID_CHANNEL_BY_TYPE = {
    message: 'messages',
    like: 'likes',
    unlike: 'likes',
    comment: 'comments',
    follow: 'follows',
    follow_request: 'follows',
    follow_approved: 'follows',
    mention: 'follows',
    contact_request: 'follows',
    contact_request_response: 'follows',
    business_verification: 'follows',
    // Created by the app's LocalNotificationsService.subscriptionChannel. Its own
    // channel, not 'follows': someone who muted follows to silence social noise
    // must still hear that their plan is about to end. A build that predates the
    // channel falls back to FCM's default channel.
    subscription: 'subscription',
    incoming_call: 'calls',
    call_ended: 'calls',
    call_accepted: 'calls',
    call_declined: 'calls',
};

const HIGH_PRIORITY_TYPES = new Set([
    'message',
    'incoming_call',
    'call_ended',
    'call_accepted',
    'call_declined',
]);

const resolveChannelId = (type) => ANDROID_CHANNEL_BY_TYPE[type] || 'follows';

/**
 * FCM data values must all be strings, and null/undefined must be dropped
 * rather than stringified — "null" is a truthy string on the client and would
 * be read as a real id.
 */
const stringifyData = (data = {}) =>
    Object.entries(data).reduce((acc, [key, value]) => {
        if (value === null || value === undefined) return acc;
        acc[key] = String(value);
        return acc;
    }, {});

/**
 * Send one FCM push to one device token.
 *
 * Deliberately built here rather than through the generic helper in
 * firebase-admin.config.js: that helper hardcodes the Android channel to
 * "calls" for everything that is not a chat message (see ANDROID_CHANNEL_BY_TYPE
 * above for why that matters), and it is shared with the call flow, which we
 * must not disturb.
 *
 * The message carries a top-level `notification` block on purpose. A DATA-ONLY
 * FCM message is handed to the app's background handler and is only displayed
 * if that handler runs — on a killed app, on OEM builds that aggressively stop
 * background isolates (Xiaomi/Oppo/Vivo/Samsung), it frequently never runs and
 * the user sees nothing. With a `notification` block the OS itself posts the
 * tray notification whether or not any Dart code executes, and `data` still
 * rides along for the tap handler.
 */
const sendFcmToToken = async (fcmToken, { title, body, type, data }) => {
    const messaging = getMessaging();
    const channelId = resolveChannelId(type);
    const highPriority = HIGH_PRIORITY_TYPES.has(type);

    const message = {
        token: fcmToken,
        notification: { title, body },
        data: stringifyData({ ...data, type }),
        android: {
            // Transport priority, not visual weight. "normal" lets Doze hold a
            // message until the next maintenance window, which on a phone that
            // has been idle overnight reads to the user as "the notification
            // never came". Visual weight is set by the channel and by
            // notification.priority below, so sending high here costs nothing.
            priority: 'high',
            notification: {
                channelId,
                priority: highPriority ? 'high' : 'default',
                defaultVibrateTimings: true,
                sound: 'default',
            },
        },
        apns: {
            payload: {
                aps: {
                    alert: { title, body },
                    sound: 'default',
                    contentAvailable: true,
                },
            },
        },
    };

    return messaging.send(message);
};

const isDeadTokenError = (error) =>
    error?.code === 'messaging/registration-token-not-registered' ||
    error?.code === 'messaging/invalid-registration-token' ||
    error?.code === 'messaging/invalid-argument' ||
    error?.message?.includes('Requested entity was not found') ||
    error?.message?.includes('not a valid FCM registration token');

/**
 * Deliver a notification to every device the given users have registered.
 *
 * Never throws and never rejects: a push is an extra, and a dead device token
 * must not roll back the follow / contact request / approval that produced it.
 *
 * @param {Array|string} userIds   recipient user id(s)
 * @param {object} payload
 * @param {string} payload.title   tray title
 * @param {string} payload.body    tray body
 * @param {string} payload.type    notification type — drives client routing AND
 *                                 the Android channel; must match the `type`
 *                                 values the clients switch on
 * @param {object} [payload.data]  extra key/values for the tap handler
 *                                 (senderId, postId, chatId, …)
 * @param {string} [payload.url]   website deep link, used by web-push only
 */
export const deliverPush = async (userIds, { title, body, type, data = {}, url } = {}) => {
    try {
        const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
        if (ids.length === 0 || !title) return;

        // WEBSITE (web-push / VAPID). Best-effort, already swallows its own errors.
        try {
            await sendWebPush(ids, {
                title,
                body,
                tag: type || 'notification',
                url: url || '/notifications',
                senderId: data.senderId,
            });
        } catch (webPushError) {
            console.warn(`[push] web-push failed: ${webPushError?.message}`);
        }

        // MOBILE (FCM). Skipped entirely when Firebase credentials are absent,
        // which is the normal state on a local dev box.
        if (!admin.apps.length) return;

        // `$nin: [null, '']` also excludes documents with no fcmToken field at
        // all, so a user who has never registered a device is simply not in the
        // result set — no empty-token send, no bogus "invalid token" log.
        const recipients = await User.find({
            _id: { $in: ids },
            fcmToken: { $nin: [null, ''] },
        }).select('fcmToken').lean();

        if (recipients.length === 0) return;

        await Promise.allSettled(recipients.map(async (recipient) => {
            try {
                await sendFcmToToken(recipient.fcmToken, { title, body, type, data });
            } catch (error) {
                if (isDeadTokenError(error)) {
                    // The device uninstalled, or Firebase rotated the token and
                    // the app has not re-registered. Clearing it stops us
                    // pushing into a black hole on every future event, and the
                    // app re-registers on its next launch.
                    await User.updateOne(
                        { _id: recipient._id, fcmToken: recipient.fcmToken },
                        { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } }
                    ).catch(() => { });
                    return;
                }
                console.warn(`[push] FCM send failed for ${recipient._id}: ${error?.message}`);
            }
        }));
    } catch (error) {
        console.error('[push] deliverPush failed:', error?.message || error);
    }
};

export default { deliverPush };
