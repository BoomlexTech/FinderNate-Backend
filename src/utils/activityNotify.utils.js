import Notification from '../models/notification.models.js';
import { User } from '../models/user.models.js';
import notificationCache from './notificationCache.utils.js';
import { deliverPush } from '../services/pushDelivery.service.js';

/**
 * Store, emit and push one activity notification (Phase 2).
 *
 * The same three steps every create*Notification in
 * controllers/notification.controllers.js performs, in one place for the
 * Phase 2 types (mentions, story likes/comments, reposts, collabs,
 * milestones). The push is detached: it must never slow down or fail the
 * action that caused it.
 *
 * Returns the Notification, or null when there is nothing to send (no
 * recipient, or someone acting on their own content).
 */
export const notifyActivity = async ({
    recipientId,
    senderId = null,
    type,
    message,
    postId = null,
    commentId = null,
    storyId = null,
    data = undefined,
    push = {},
}) => {
    if (!recipientId || !type) return null;
    if (senderId && String(senderId) === String(recipientId)) return null;

    const notification = await Notification.create({
        receiverId: recipientId,
        senderId,
        type,
        message,
        postId,
        commentId,
        storyId,
        data,
    });

    if (global.io) global.io.to(`user_${recipientId}`).emit('notification', notification);
    try {
        await notificationCache.invalidateNotificationCache(recipientId);
    } catch { /* the count self-heals on its TTL */ }

    (async () => {
        let name = 'Someone';
        let avatar = '';
        if (senderId) {
            const sender = await User.findById(senderId).select('username fullName profileImageUrl').lean();
            name = sender?.fullName || sender?.username || name;
            avatar = sender?.profileImageUrl || '';
        }
        await deliverPush(recipientId, {
            title: push.title || 'Findernate',
            body: push.body || (senderId ? `${name} ${message}` : message),
            type,
            data: {
                ...(senderId ? { senderId: String(senderId), senderName: name, senderAvatar: avatar } : {}),
                ...(postId ? { postId: String(postId) } : {}),
                ...(commentId ? { commentId: String(commentId) } : {}),
                ...(storyId ? { storyId: String(storyId) } : {}),
                notificationId: String(notification._id),
                ...(push.data || {}),
            },
            url: push.url || (postId ? `/post/${postId}` : '/notifications'),
        });
    })().catch(() => { });

    return notification;
};
