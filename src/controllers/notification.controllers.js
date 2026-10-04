import Notification from "../models/notification.models.js";
import Message from "../models/message.models.js";
import Chat from "../models/chat.models.js";
import Post from "../models/userPost.models.js";
import { buildDeletedTombstone } from "../utils/contentTombstone.utils.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import notificationCache from "../utils/notificationCache.utils.js";
import { User } from "../models/user.models.js";
import { sendEmail } from "../utils/sendEmail.js";
import { renderEmail, emailParagraph, emailCallout } from "../utils/emailTemplate.js";
import { deliverPush } from "../services/pushDelivery.service.js";
import { buildSubscriptionNotice, settleWithin } from "../utils/subscriptionNotice.utils.js";

// How long a plan notice waits for its push or its email before moving on. The
// mail transport has no timeout shorter than minutes, and the reminder job sends
// one notice after another, so one unreachable mail host would otherwise hold
// back every later user's reminder (and the claim for the hung one stays taken).
export const SUBSCRIPTION_SEND_TIMEOUT_MS = 15000;

const sendRealTimeNotification = async (recipientId, notification, overrides = {}) => {
    // Use Socket.IO Redis adapter to emit to user across all processes
    if (global.io) {
        // `overrides` exists for events whose real type the Notification schema
        // enum cannot store yet (contact requests). The clients switch on
        // `type` to pick a title, an icon and a tap destination, so the socket
        // payload must carry the specific type even while the stored document
        // falls back to "others". Remove the override once the enum accepts it.
        const payload = Object.keys(overrides).length
            ? { ...(notification.toObject?.() ?? notification), ...overrides }
            : notification;
        global.io.to(`user_${recipientId}`).emit("notification", payload);
    }
};

/**
 * Everything a push needs to say WHO did the thing.
 *
 * Pushes are fire-and-forget, so a missing user must degrade to a readable
 * "Someone" rather than take the notification down with it.
 */
const getSenderSummary = async (sourceUserId) => {
    if (!sourceUserId) return { name: 'Someone', avatar: '' };
    try {
        const sender = await User.findById(sourceUserId)
            .select('username fullName profileImageUrl')
            .lean();
        return {
            name: sender?.fullName || sender?.username || 'Someone',
            avatar: sender?.profileImageUrl || '',
        };
    } catch {
        return { name: 'Someone', avatar: '' };
    }
};

// 🟢 Like Notification
export const createLikeNotification = async ({ recipientId, sourceUserId, postId, commentId }) => {
    if (!recipientId || !sourceUserId || (!postId && !commentId)) return;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "like",
        senderId: sourceUserId,
        postId,
        commentId,
        message: commentId ? "liked your comment" : "liked your post"
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);

    // Detached on purpose, the same shape chat/message.controllers.js uses: the
    // socket event is what an OPEN app reacts to, the push is only for the app
    // that is not open, and neither the sender lookup nor an FCM round-trip
    // should sit in the critical path of tapping a heart.
    (async () => {
        const sender = await getSenderSummary(sourceUserId);
        await deliverPush(recipientId, {
            title: 'New like',
            body: `${sender.name} ${commentId ? 'liked your comment' : 'liked your post'}`,
            type: 'like',
            data: {
                senderId: String(sourceUserId),
                senderName: sender.name,
                senderAvatar: sender.avatar,
                postId: postId ? String(postId) : undefined,
                commentId: commentId ? String(commentId) : undefined,
                notificationId: String(notification._id),
            },
            url: postId ? `/post/${postId}` : '/notifications',
        });
    })().catch(() => { });
};

// 🟡 Comment Notification
export const createCommentNotification = asyncHandler(async ({ recipientId, sourceUserId, postId, commentId, isReply = false }) => {
    if (!recipientId || !sourceUserId || !postId || !commentId) {
        throw new ApiError(400, "recipientId, sourceUserId, postId, and commentId are required");
    }

    const type = "comment";
    const message = isReply ? "replied to your comment" : "commented on your post";

    const notification = await Notification.create({
        receiverId: recipientId,
        type,
        senderId: sourceUserId,
        postId,
        commentId,
        message
    });

    sendRealTimeNotification(recipientId, notification);

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(recipientId);

    (async () => {
        const sender = await getSenderSummary(sourceUserId);
        await deliverPush(recipientId, {
            title: 'New comment',
            body: `${sender.name} ${message}`,
            type: 'comment',
            data: {
                senderId: String(sourceUserId),
                senderName: sender.name,
                senderAvatar: sender.avatar,
                postId: String(postId),
                commentId: String(commentId),
                notificationId: String(notification._id),
            },
            url: `/post/${postId}`,
        });
    })().catch(() => { });
});

/**
 *  Follow Notification — a plain follow, a follow REQUEST to a private
 * account, or the APPROVAL of one.
 *
 * followUser/approveFollowRequest have always passed `isRequest` / `isApproval`
 * here, but nothing read them: every one of the three wrote "started following
 * you". Someone who merely *asked* to follow a private account was announced as
 * an actual follower, which is both wrong and misleading about what the
 * recipient still has to act on.
 *
 * The push type matters as much as the text. The mobile client attaches the
 * "Follow Back" action to a push whose data type is exactly `follow`
 * (FirebaseMessagingService._showLocalNotification), and Follow Back is only
 * meaningful for a real follow — you cannot follow back a pending request, and
 * you already follow the person who just approved you. So the two other cases
 * ship distinct types and get no action button.
 */
export const createFollowNotification = async ({ recipientId, sourceUserId, isRequest = false, isApproval = false }) => {
    if (!recipientId || !sourceUserId) return;

    const message = isRequest
        ? "requested to follow you"
        : isApproval
            ? "accepted your follow request"
            : "started following you";

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "follow",
        senderId: sourceUserId,
        message
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);

    const pushType = isRequest ? 'follow_request' : isApproval ? 'follow_approved' : 'follow';

    (async () => {
        const sender = await getSenderSummary(sourceUserId);
        await deliverPush(recipientId, {
            title: isRequest
                ? 'New follow request'
                : isApproval
                    ? 'Follow request accepted'
                    : 'New follower',
            body: `${sender.name} ${message}`,
            type: pushType,
            data: {
                // senderId is what the "Follow Back" handler follows
                // (LocalNotificationsService.notificationSenderId → followUserOnBackend),
                // and what a plain tap opens the profile of. Without it the
                // button is rendered but does nothing.
                senderId: String(sourceUserId),
                senderName: sender.name,
                senderAvatar: sender.avatar,
                notificationId: String(notification._id),
                // Explicit action hint so a client that does not want to infer
                // the button from `type` can still render it.
                action: pushType === 'follow' ? 'follow_back' : undefined,
            },
            url: '/notifications',
        });
    })().catch(() => { });
};

/**
 * Someone asked a business for its contact details.
 *
 * Until this existed, sendContactRequest wrote a ContactRequest row and
 * returned 201 — and that was the whole story. The owner got no push, no
 * socket event and no row in the notification list, so the only way to find out
 * was to remember to open the contact-requests inbox. Requests sat unanswered
 * because nobody knew they had arrived.
 *
 * The stored `type` is "others" because the Notification schema enum does not
 * yet list "contact_request"; the socket payload and the push both carry the
 * real type, which is what every client actually switches on (the Flutter app
 * already has explicit `contact_request` cases in both its title builder and
 * its tap router). See the note on sendRealTimeNotification.
 */
export const createContactRequestNotification = async ({ recipientId, sourceUserId, businessId, businessName, requestId, requestMessage }) => {
    if (!recipientId || !sourceUserId) return;

    const message = businessName
        ? `requested contact details for ${businessName}`
        : 'requested your contact details';

    const notification = await Notification.create({
        receiverId: recipientId,
        type: 'others',
        senderId: sourceUserId,
        message,
    });

    sendRealTimeNotification(recipientId, notification, { type: 'contact_request' });
    await notificationCache.invalidateNotificationCache(recipientId);

    (async () => {
        const sender = await getSenderSummary(sourceUserId);
        await deliverPush(recipientId, {
            title: 'Contact info requested',
            body: requestMessage
                ? `${sender.name}: ${requestMessage.length > 80 ? `${requestMessage.substring(0, 80)}…` : requestMessage}`
                : `${sender.name} ${message}`,
            type: 'contact_request',
            data: {
                senderId: String(sourceUserId),
                senderName: sender.name,
                senderAvatar: sender.avatar,
                businessId: businessId ? String(businessId) : undefined,
                requestId: requestId ? String(requestId) : undefined,
                notificationId: String(notification._id),
            },
            url: '/notifications',
        });
    })().catch(() => { });
};

/**
 * The business owner answered a contact request — tell the person who asked.
 *
 * The requester had exactly the same blind spot as the owner: an approval only
 * became visible if they went back to the business page and re-checked the
 * status endpoint.
 */
export const createContactResponseNotification = async ({ recipientId, sourceUserId, businessId, businessName, requestId, status, responseMessage }) => {
    if (!recipientId || !status) return;

    const approved = status === 'approved';
    const subject = businessName ? `${businessName}` : 'the business';
    const message = approved
        ? `shared contact details for ${subject}`
        : `declined your contact request for ${subject}`;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: 'others',
        senderId: sourceUserId || null,
        message: responseMessage ? `${message}: ${responseMessage}` : message,
    });

    sendRealTimeNotification(recipientId, notification, { type: 'contact_request_response' });
    await notificationCache.invalidateNotificationCache(recipientId);

    (async () => {
        const sender = await getSenderSummary(sourceUserId);
        await deliverPush(recipientId, {
            title: approved ? 'Contact request approved' : 'Contact request declined',
            body: approved
                ? `You can now see the contact details for ${subject}`
                : `Your contact request for ${subject} was declined`,
            type: 'contact_request_response',
            data: {
                senderId: sourceUserId ? String(sourceUserId) : undefined,
                senderName: sender.name,
                senderAvatar: sender.avatar,
                businessId: businessId ? String(businessId) : undefined,
                requestId: requestId ? String(requestId) : undefined,
                status: String(status),
                notificationId: String(notification._id),
            },
            url: '/notifications',
        });
    })().catch(() => { });
};

/**
 * Business verification decided by an admin — approved or rejected.
 *
 * Until this existed, an admin approved a business and the owner had no way to
 * find out. Nothing was written, nothing was sent, and no socket event fired:
 * the only way to learn the outcome was to open the profile and look, which
 * assumes you knew to keep checking.
 *
 * Sent two ways on purpose. The in-app notification is the record, and the
 * email is what actually reaches someone — a decision can land days after they
 * last opened the app, which is exactly when an in-app-only notice is missed.
 *
 * senderId is left null: the decision comes from the platform, and admins are
 * not Users, so there is no honest id to attribute it to.
 */
export const createBusinessVerificationNotification = async ({
    recipientId,
    approved,
    businessName,
    remarks,
}) => {
    if (!recipientId) return;

    const message = approved
        ? `Your business profile${businessName ? ` for ${businessName}` : ''} has been approved`
        : `Your business profile${businessName ? ` for ${businessName}` : ''} was not approved${remarks ? `: ${remarks}` : ''}`;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: 'business_verification',
        senderId: null,
        message,
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);

    deliverPush(recipientId, {
        title: approved ? 'Business profile approved' : 'Business profile update',
        body: message,
        type: 'business_verification',
        data: { notificationId: String(notification._id) },
        url: '/notifications',
    });

    // Email is best-effort and deliberately not awaited into the caller's
    // failure path: a bounced address must not roll back an approval an admin
    // has already made.
    try {
        const user = await User.findById(recipientId).select('email fullName username');
        if (user?.email) {
            const name = user.fullName || user.username || 'there';
            // fullName, businessName and the admin's remarks are all free text
            // and were previously interpolated raw. emailParagraph/emailCallout
            // escape everything they are given, so a name or a rejection reason
            // containing `<` can no longer swallow the rest of the message.
            const forBusiness = businessName ? ` for ${businessName}` : '';
            const title = approved
                ? 'Your business profile is approved'
                : 'About your business profile';

            const bodyHtml = approved
                ? emailParagraph(`Hi ${name},`, { topGap: 0 })
                  + emailParagraph(`Your business profile${forBusiness} has been approved.`)
                  + emailParagraph('You can now use the business features on FinderNate.')
                : emailParagraph(`Hi ${name},`, { topGap: 0 })
                  + emailParagraph(`Your business profile${forBusiness} could not be approved yet.`)
                  + (remarks ? emailCallout(`Reason: ${remarks}`) : '')
                  + emailParagraph('You can update your details and submit again from your profile settings.');

            const text = [
                title, '',
                `Hi ${name},`, '',
                approved
                    ? `Your business profile${forBusiness} has been approved.`
                    : `Your business profile${forBusiness} could not be approved yet.`,
                ...(approved ? ['You can now use the business features on FinderNate.']
                             : [...(remarks ? [`Reason: ${remarks}`] : []),
                                'You can update your details and submit again from your profile settings.']),
                '', '--', 'findernate.com',
            ].join('\n');

            await sendEmail({
                to: user.email,
                subject: approved
                    ? 'Your Findernate business profile is approved'
                    : 'About your Findernate business profile',
                html: renderEmail({
                    title,
                    preheader: approved
                        ? 'Your business profile has been approved.'
                        : 'There is an update on your business profile.',
                    bodyHtml,
                }),
                text,
            });
        }
    } catch (e) {
        console.warn(`[notify] business verification email failed for ${recipientId}: ${e?.message}`);
    }
};

/**
 * Something happened to a business's plan: it started, changed, was extended,
 * will not renew, is about to end or has ended.
 *
 * Until this existed the only way to learn a plan was ending was to open the
 * Subscription screen and read the date. A website plan is one paid month with
 * no renewal, so the user who forgot simply dropped to Free one morning and
 * found out when a feature stopped working.
 *
 * Same shape as createBusinessVerificationNotification: a platform notice
 * (senderId null) that is stored, emitted on the socket, pushed, and for the
 * events that matter also emailed. WHAT it says lives in buildSubscriptionNotice.
 *
 * WHEN it is sent is not decided here. Callers go through
 * controllers/subscription/notices.js, which makes each transition notify once
 * and keeps a failure here from reaching billing. This function therefore throws
 * only while nothing has been delivered yet (the account lookup or the row write
 * failed, so the caller can give its claim back and a retry cannot double-send);
 * everything after the row exists is best-effort and logged.
 *
 * @returns the Notification row, or null when there was nothing to send (an
 *          unknown event, or an account that no longer exists).
 */
export const createSubscriptionNotification = async ({
    recipientId,
    event,
    plan,
    pendingPlan,
    endDate,
    source,
    daysLeft,
    reason,
}) => {
    if (!recipientId) return null;

    const notice = buildSubscriptionNotice({ event, plan, pendingPlan, endDate, source, daysLeft, reason });
    if (!notice) return null;

    // A Subscription row can outlive its account, and a notification addressed to
    // a deleted user is only clutter that no one will ever read. Looked up here
    // rather than by the caller because the email needs the same document.
    const user = await User.findById(recipientId).select('email fullName username isDeleted').lean();
    if (!user || user.isDeleted) return null;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: 'subscription',
        senderId: null,
        message: notice.message,
    });

    try {
        await sendRealTimeNotification(recipientId, notification);
        await notificationCache.invalidateNotificationCache(recipientId);
    } catch (e) {
        console.warn(`[notify] subscription notice socket/cache step failed for ${recipientId}: ${e?.message}`);
    }

    // Push and email run side by side and neither can fail the other. deliverPush
    // never rejects; the catch is for a future change that makes it.
    const sending = [
        (async () => {
            try {
                await deliverPush(recipientId, {
                    title: notice.title,
                    body: notice.message,
                    type: 'subscription',
                    data: { notificationId: String(notification._id), event },
                    url: '/subscription',
                });
            } catch (e) {
                console.warn(`[notify] subscription push failed for ${recipientId}: ${e?.message}`);
            }
        })(),
    ];

    if (notice.email && user.email) {
        sending.push((async () => {
            try {
                const name = user.fullName || user.username || 'there';
                // emailParagraph/emailCallout escape what they are given, and the
                // plain-text part is not HTML at all, so a name containing `<`
                // cannot reshape either.
                const bodyHtml = emailParagraph(`Hi ${name},`, { topGap: 0 })
                    + notice.email.paragraphs.map((p) => emailParagraph(p)).join('')
                    + emailCallout(notice.email.callout);
                const text = [
                    notice.email.title, '',
                    `Hi ${name},`, '',
                    ...notice.email.paragraphs,
                    '', notice.email.callout,
                    '', '--', 'findernate.com',
                ].join('\n');

                const result = await sendEmail({
                    to: user.email,
                    subject: notice.email.subject,
                    html: renderEmail({
                        title: notice.email.title,
                        preheader: notice.email.preheader,
                        bodyHtml,
                    }),
                    text,
                });
                if (result && result.success === false) {
                    console.warn(`[notify] subscription email not delivered to ${recipientId}: ${result.error}`);
                }
            } catch (e) {
                console.warn(`[notify] subscription email failed for ${recipientId}: ${e?.message}`);
            }
        })());
    }

    // Each task catches its own errors, so this only waits for them to finish, and
    // not for longer than a notice can afford to (the work carries on unattended).
    await Promise.allSettled(sending.map((task) => settleWithin(
        task,
        SUBSCRIPTION_SEND_TIMEOUT_MS,
        () => console.warn(`[notify] subscription push/email for ${recipientId} still running after ${SUBSCRIPTION_SEND_TIMEOUT_MS} ms, not waiting`)
    )));
    return notification;
};

// 🔴 Unlike Notification
export const createUnlikeNotification = async ({ recipientId, sourceUserId, postId, commentId }) => {
    if (!recipientId || !sourceUserId || (!postId && !commentId)) return;

    const notification = await Notification.create({
        receiverId: recipientId,
        type: "unlike",
        senderId: sourceUserId,
        postId,
        commentId,
        message: commentId ? "unliked your comment" : "unliked your post"
    });

    sendRealTimeNotification(recipientId, notification);
    await notificationCache.invalidateNotificationCache(recipientId);
};

//  Get Logged-in User's Notifications
export const getNotifications = asyncHandler(async (req, res) => {
    const receiverId = req.user._id;
    const blockedUsers = req.blockedUsers || [];

    // Paged like the other list endpoints (?page&limit, same clamps as
    // getFollowers). This used to return — and populate — the user's ENTIRE
    // notification history on every call, and the web sidebar calls it on every
    // page load and again every five minutes, so a long-standing account was
    // downloading thousands of records for a badge count.
    //
    // The payload stays a plain array because the shipped mobile app reads
    // `data` as one (notification_services.dart:652); the page/total counts go
    // in headers so no client breaks.
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));

    // Build query to exclude notifications from blocked users
    const query = { receiverId };
    if (blockedUsers.length > 0) {
        query.senderId = { $nin: blockedUsers };
    }

    const [notifications, totalCount] = await Promise.all([
        Notification.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate("senderId", "username profileImageUrl")
            .lean(),
        Notification.countDocuments(query),
    ]);

    // A notification outlives the post it points at — nothing rewrites or removes
    // it when the author deletes the post — so "X liked your post" sat in the list
    // with a deep link that opened an error. One id lookup for the page marks
    // those entries up front, so the client can render the tombstone in place and
    // not navigate into a dead screen at all.
    //
    // Purely additive: `deletedContent` is absent on every notification whose
    // target still exists, and the payload stays a plain array (the shipped
    // mobile app reads `data` as one).
    const referencedPostIds = [...new Set(
        notifications.filter(n => n.postId).map(n => n.postId.toString())
    )];

    if (referencedPostIds.length) {
        const livePosts = await Post.find({ _id: { $in: referencedPostIds } })
            .select('_id')
            .lean();
        const livePostIds = new Set(livePosts.map(p => p._id.toString()));

        notifications.forEach(n => {
            if (n.postId && !livePostIds.has(n.postId.toString())) {
                // The post's own contentType died with it, so this says "post" —
                // true of every deleted post regardless of what it was selling.
                n.deletedContent = buildDeletedTombstone({
                    contentType: 'post',
                    contentId: n.postId,
                });
            }
        });
    }

    res.set({
        'X-Total-Count': String(totalCount),
        'X-Page': String(page),
        'X-Limit': String(limit),
        'X-Total-Pages': String(Math.ceil(totalCount / limit)),
    });

    res.status(200).json(new ApiResponse(200, notifications, "Notifications fetched successfully"));
});

// 📤 Mark a Notification as Read
export const markNotificationAsRead = asyncHandler(async (req, res) => {
    const { notificationId } = req.params;

    const notification = await Notification.findById(notificationId);
    if (!notification) throw new ApiError(404, "Notification not found");

    notification.isRead = true;
    await notification.save();

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(notification.receiverId);

    res.status(200).json(new ApiResponse(200, notification, "Notification marked as read"));
});

// 📤 Mark All Notifications as Read
export const markAllNotificationsAsRead = asyncHandler(async (req, res) => {
    const receiverId = req.user._id;

    await Notification.updateMany({ receiverId, isRead: false }, { $set: { isRead: true } });

    // Invalidate cache and emit real-time count update
    await notificationCache.invalidateNotificationCache(receiverId);

    res.status(200).json(new ApiResponse(200, {}, "All notifications marked as read"));
});

// ❌ Delete a Notification
export const deleteNotification = asyncHandler(async (req, res) => {
    const { notificationId } = req.params;

    const notification = await Notification.findById(notificationId);
    if (!notification) throw new ApiError(404, "Notification not found");

    await notification.deleteOne();

    res.status(200).json(new ApiResponse(200, {}, "Notification deleted successfully"));
});

// 📊 Get Unread Counts (Notifications & Messages) - Now with caching and deprecation warning
export const getUnreadCounts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const userToken = req.headers.authorization?.split(" ")[1] || req.cookies?.accessToken;

    try {
        // Get counts from cache first, then database if needed
        const counts = await notificationCache.getUnreadCounts(userId);

        const response = {
            unreadNotifications: counts.unreadNotifications,
            unreadMessages: counts.unreadMessages,
            userToken: userToken,
            timestamp: new Date().toISOString(),
            fromCache: counts.fromCache,
            // Deprecation warning for polling
            warning: "⚠️ Consider using WebSocket events instead of polling this endpoint. Listen to 'unread_counts_updated' event for real-time updates."
        };

        res.status(200).json(new ApiResponse(200, response, "Unread counts fetched successfully"));
    } catch (error) {
        throw new ApiError(500, "Error fetching unread counts: " + error.message);
    }
});

// 🚀 NEW: Get Initial Unread Counts (for app startup only)
export const getInitialUnreadCounts = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    try {
        const counts = await notificationCache.getUnreadCounts(userId);

        const response = {
            unreadNotifications: counts.unreadNotifications,
            unreadMessages: counts.unreadMessages,
            timestamp: new Date().toISOString(),
            fromCache: counts.fromCache,
            message: "Use Socket.IO 'unread_counts_updated' events for live updates instead of polling."
        };

        res.status(200).json(new ApiResponse(200, response, "Initial unread counts fetched successfully"));
    } catch (error) {
        throw new ApiError(500, "Error fetching initial unread counts: " + error.message);
    }
});
