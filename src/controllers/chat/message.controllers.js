import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { User } from '../../models/user.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { uploadBufferToBunny, isBunnyUrl } from '../../utils/bunny.js';
import { CHAT_MEDIA_LIMITS_MB, POST_MEDIA_LIMITS_MB, tooLargeMessage } from '../../constants/uploadLimits.js';
import socketManager from '../../config/socket.js';
import { sendPushNotification } from '../pushNotification.controllers.js';
import notificationCache from '../../utils/notificationCache.utils.js';
import { redisClient } from '../../config/redis.config.js';
import { calculateMessageStatus } from '../../utils/messageStatus.utils.js';
import { safeEmitToChat, assertNotBlockedInChat, isChatMutedFor } from './helpers.js';
import { buildSharedPostSnapshot, sharedPostSummary, recordPostShare } from '../../utils/sharedPost.utils.js';
import { notExpiredFilter, redactViewOnce, expiryFor, viewOnceAllowed, parseBool, previewLabel, joinedAtOf, VIEW_ONCE_UNOPENED_TTL_MS } from '../../utils/chatRoles.rules.js';
import { prepareEncryptedMessage, markChatEncrypted } from '../../utils/e2ee.utils.js';
import { lookupGif } from '../../services/giphy.service.js';
import { getPushTargets, sendFcmToTargets } from '../../services/pushTargets.service.js';

// Ceiling on how many messages one request may pull, matching the one
// getUserChats already applies. Without it ?limit=100000 made the server fetch,
// populate and serialise a hundred thousand documents in a single response.
const MAX_MESSAGE_PAGE_LIMIT = 100;

const safeJsonArray = (s) => {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};

// Turns user input into a literal for $regex — same helper as search.controllers.js.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getChatMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageLimit = Math.min(Math.max(1, parseInt(limit) || 50), MAX_MESSAGE_PAGE_LIMIT);
    const skip = (pageNum - 1) * pageLimit;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // A blocked pair cannot READ each other's conversation either — receiving
    // is half of "blocked users can still chat".
    //
    // Direct chats only: a block between two members of a GROUP hides them
    // from each other elsewhere, but it must not shut the whole group down for
    // everyone in it.
    if (chat.chatType === 'direct') {
        await assertNotBlockedInChat(currentUserId, chat.participants, 'read');
    }

    if (socketManager.isReady()) {
        const userSocketId = socketManager.connectedUsers.get(currentUserId.toString());
        if (userSocketId) {
            const io = socketManager.io;
            const socket = io.sockets.sockets.get(userSocketId);
            if (socket) {
                socket.join(`chat:${chatId}`);
                socket.chatRooms = socket.chatRooms || new Set();
                socket.chatRooms.add(chatId);
            }
        }
    }

    if (chat.status === 'requested') {
        if (chat.createdBy.toString() !== currentUserId.toString()) {
            return res.status(200).json(
                new ApiResponse(200, {
                    messages: [],
                    chatStatus: 'requested',
                    requestedBy: chat.createdBy,
                    pagination: {
                        currentPage: 1,
                        totalPages: 0,
                        totalMessages: 0,
                        hasNextPage: false,
                        hasPrevPage: false
                    }
                }, 'Chat request pending acceptance')
            );
        }
    } else if (chat.status === 'declined') {
        throw new ApiError(403, 'This chat request has been declined');
    }

    const messageQuery = {
        chatId,
        $and: [
            { deletedForEveryone: { $ne: true } },
            { 'deletedFor.userId': { $ne: currentUserId } },
            // Disappearing messages (#37) vanish on time, before the purge job runs.
            notExpiredFilter()
        ]
    };
    // Someone added to a group sees messages from when they joined (#21).
    const joinedAt = chat.chatType === 'group' ? joinedAtOf(chat, currentUserId) : null;
    if (joinedAt) {
        messageQuery.$and.push({ timestamp: { $gte: joinedAt } });
    }

    const [messages, totalMessages] = await Promise.all([
        Message.find(messageQuery)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pageLimit)
            // storyReference belongs in this list. The socket emit sends the
            // whole populated document, so a story reply looks right the
            // moment it arrives — but history comes through here, and a field
            // missing from this select vanishes on the next refresh. That
            // failure mode reads as "the attachment disappeared", which is
            // worse than never having shown it.
            .select('sender message messageType mediaUrl fileName fileSize duration timestamp readBy replyTo reactions deletedForEveryone productReference storyReference sharedPost linkPreview checkoutDetails isEdited isForwarded forwardedFrom isPinned deliveryStatus fontStyle waveform system gif expiresAt viewOnce viewOnceOpenedBy viewOnceExpired e2ee')
            .populate('sender', 'username fullName profileImageUrl')
            .populate({
                path: 'replyTo',
                select: 'message sender timestamp',
                populate: {
                    path: 'sender',
                    select: 'username fullName'
                }
            })
            .lean(),
        Message.countDocuments(messageQuery)
    ]);

    const processedMessages = messages.map(msg => {
        // View-once (#48): the link is only handed out by the open endpoint.
        if (msg.viewOnce) {
            msg = redactViewOnce(msg, currentUserId);
        }
        if (msg.deletedForEveryone) {
            return {
                ...msg,
                message: '',
                mediaUrl: null,
                fileName: null,
                fileSize: null,
                deletedForEveryone: true,
                deletedForEveryoneAt: msg.deletedForEveryoneAt
            };
        }
        return msg;
    });

    if (pageNum === 1 && processedMessages.length > 0) {
        const latestNonDeletedMessage = processedMessages.find(msg => !msg.deletedForEveryone);

        if (latestNonDeletedMessage) {
            if (!chat.lastMessageId ||
                (latestNonDeletedMessage._id.toString() !== chat.lastMessageId.toString())) {
                chat.lastMessage = {
                    sender: latestNonDeletedMessage.sender._id,
                    message: latestNonDeletedMessage.message,
                    timestamp: latestNonDeletedMessage.timestamp
                };
                chat.lastMessageId = latestNonDeletedMessage._id;
                await chat.save();
            }
        }
    }

    const messagesWithStatus = processedMessages.map(msg => {
        if (msg.sender._id.toString() === currentUserId.toString()) {
            return {
                ...msg,
                status: calculateMessageStatus(msg, chat.participants)
            };
        }
        return msg;
    });

    return res.status(200).json(
        new ApiResponse(200, {
            messages: messagesWithStatus.reverse(),
            disappearingSeconds: Number(chat.disappearing?.seconds) || 0,
            e2ee: !!chat.e2ee?.enabled,
            chatType: chat.chatType,
            participantIds: chat.participants.map(p => p.toString()),
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalMessages / pageLimit),
                totalMessages,
                hasNextPage: pageNum < Math.ceil(totalMessages / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Messages fetched successfully')
    );
});

export const addMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const body = req.body || {};
    const message = body.message;
    const messageType = body.messageType || 'text';
    const replyTo = body.replyTo;
    const mediaFile = req.file;

    const productReference = (messageType === 'contact_seller' && body.productReference) ? (
        typeof body.productReference === 'string'
            ? JSON.parse(body.productReference)
            : body.productReference
    ) : null;

    // Replies sent from the story viewer. Gated on the type the same way
    // productReference is, so an ordinary text message cannot smuggle one in.
    // Parsed defensively: multipart sends it as a JSON string, the JSON alias
    // route sends it as an object.
    const storyReference = (messageType === 'story_reply' && body.storyReference) ? (
        typeof body.storyReference === 'string'
            ? JSON.parse(body.storyReference)
            : body.storyReference
    ) : null;

    // Sharing a post or vibe into the chat (#24). Body: { messageType:
    // 'shared_post', sharedPostId, message? }. The snapshot is built
    // server-side; nothing the client sends about the post is trusted.
    let sharedPost = null;
    if (messageType === 'shared_post') {
        const sharedPostId = body.sharedPostId || body.postId;
        if (!sharedPostId) throw new ApiError(400, 'sharedPostId is required to share a post');
        sharedPost = await buildSharedPostSnapshot(sharedPostId, currentUserId);
    }

    // GIF or sticker (#7): body { messageType: 'gif' | 'sticker', gifId }.
    // The details come from GIPHY through our proxy, never from the client.
    let gif = null;
    if (messageType === 'gif' || messageType === 'sticker') {
        const gifId = body.gifId || body.gif?.id;
        if (!gifId) throw new ApiError(400, 'gifId is required');
        gif = await lookupGif(String(gifId));
        if (!gif) throw new ApiError(404, 'That GIF is no longer available');
    }

    // View-once photo or video (#48). Checked against the chat below.
    const viewOnce = parseBool(body.viewOnce);

    // End-to-end encrypted message (#2): the server stores the envelope as is.
    const isEncrypted = messageType === 'encrypted';

    if ((!message || message.trim().length === 0) && !mediaFile && !sharedPost && !gif && !isEncrypted) {
        throw new ApiError(400, 'Message content or media file is required');
    }

    const finalMessage = isEncrypted
        // What older app versions show; newer ones decrypt and replace it.
        ? '🔒 Encrypted message. Update Findernate to read it.'
        : message && message.trim().length > 0
        ? message.trim()
        : mediaFile
            ? `📎 ${mediaFile.originalname}`
            : sharedPost
                ? sharedPostSummary(sharedPost)
                : gif
                    ? previewLabel(messageType)
                    : '';

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    }).select('+mutes'); // needed to skip pushes to participants who muted the chat (#38)

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    if (chat.status === 'requested') {
        if (chat.createdBy.toString() !== currentUserId.toString()) {
            throw new ApiError(403, 'You must accept the chat request before sending messages');
        }
    } else if (chat.status === 'declined') {
        throw new ApiError(403, 'This chat request has been declined');
    }

    // Blocked in either direction: the message is refused before anything is
    // written, uploaded or pushed. Checked here rather than only at chat
    // creation because a conversation that predates the block is still open
    // on both clients. Group chats are exempt — see getChatMessages.
    if (chat.chatType === 'direct') {
        await assertNotBlockedInChat(currentUserId, chat.participants, 'send');
    }

    const effectiveType = mediaFile && messageType === 'text'
        ? (mediaFile.mimetype.startsWith('video/') ? 'video' : mediaFile.mimetype.startsWith('image/') ? 'image' : 'file')
        : messageType;
    if (viewOnce && !viewOnceAllowed(chat, effectiveType)) {
        throw new ApiError(400, 'View once works for photos and videos in one-to-one chats');
    }

    // Encrypted messages: validate the envelope and check it covers every
    // device that should read it. A 409 tells the sender to fetch keys again.
    let e2eeEnvelope = null;
    if (isEncrypted) {
        e2eeEnvelope = await prepareEncryptedMessage(chat, currentUserId, body.e2ee);
    }

    const recipients = chat.participants.filter(
        p => p.toString() !== currentUserId.toString()
    );

    const messageData = {
        chatId,
        sender: currentUserId,
        message: finalMessage,
        messageType,
        timestamp: new Date(),
        readBy: [currentUserId],
        replyTo: replyTo || null,
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        }))
    };

    if (productReference) {
        messageData.productReference = productReference;
    }

    if (gif) {
        messageData.gif = gif;
    }

    if (e2eeEnvelope) {
        messageData.e2ee = e2eeEnvelope;
        // Encrypted attachments live at these links (ciphertext). Only our
        // own encrypted-blob folder is accepted.
        const blobUrls = (Array.isArray(body.e2eeBlobUrls) ? body.e2eeBlobUrls
            : typeof body.e2eeBlobUrls === 'string' ? safeJsonArray(body.e2eeBlobUrls) : [])
            .filter(u => typeof u === 'string' && isBunnyUrl(u) && u.includes('/chat_e2ee/'))
            .slice(0, 10);
        if (blobUrls.length) messageData.e2eeBlobUrls = blobUrls;
    }

    if (viewOnce) {
        // The app uploads first and sends the link as the message text. For a
        // view-once message the link must only live in mediaUrl, which lists
        // never show, and the text becomes a neutral label.
        if (!mediaFile && !isEncrypted && /^https:\/\/\S+$/.test(finalMessage)) {
            messageData.mediaUrl = finalMessage;
        }
        if (!isEncrypted && !messageData.mediaUrl && !mediaFile) {
            throw new ApiError(400, 'A view-once message needs a photo or video');
        }
        messageData.message = previewLabel(effectiveType, { viewOnce: true });
        messageData.viewOnce = true;
        // Never opened: the media goes after 14 days anyway.
        messageData.viewOnceMediaDeleteAt = new Date(Date.now() + VIEW_ONCE_UNOPENED_TTL_MS);
    }

    // Disappearing messages (#37): stamp the expiry from the chat's timer.
    const expiresAt = expiryFor(chat, messageType);
    if (expiresAt) {
        messageData.expiresAt = expiresAt;
    }

    if (sharedPost) {
        messageData.sharedPost = sharedPost;
    }

    if (storyReference) {
        // Whitelisted rather than spread, so a client cannot write arbitrary
        // keys into the document. capturedAt is stamped here rather than taken
        // from the body — it records when the server saw it, which is the only
        // version worth trusting for "has this story expired".
        messageData.storyReference = {
            storyId: storyReference.storyId,
            ownerId: storyReference.ownerId,
            ownerUsername: storyReference.ownerUsername,
            mediaUrl: storyReference.mediaUrl,
            mediaType: storyReference.mediaType === 'video' ? 'video' : 'image',
            caption: storyReference.caption,
            capturedAt: new Date(),
        };
    }

    // Media sent by the mobile app is uploaded via /media/upload-single first
    // and arrives here as a URL in `message` with no req.file, so accept the
    // client-supplied metadata for those messages (validated/whitelisted).
    const bodyDuration = Number(body.duration);
    if (['audio', 'video'].includes(messageType) && Number.isFinite(bodyDuration) && bodyDuration > 0) {
        messageData.duration = bodyDuration;
    }
    if (messageType === 'file' && typeof body.fileName === 'string' && body.fileName.trim()) {
        messageData.fileName = body.fileName.trim();
    }

    if (mediaFile) {
        let detectedCategory;
        if (mediaFile.mimetype.startsWith('image/')) {
            detectedCategory = 'image';
        } else if (mediaFile.mimetype.startsWith('video/')) {
            detectedCategory = 'video';
        } else if (mediaFile.mimetype.startsWith('audio/')) {
            detectedCategory = 'audio';
        } else {
            detectedCategory = 'file';
        }

        const limitMB = CHAT_MEDIA_LIMITS_MB[detectedCategory];
        if (mediaFile.size > limitMB * 1024 * 1024) {
            // Chat ceilings are lower than a post's, so say so and name the
            // way round it rather than leaving the user stuck.
            throw new ApiError(413, tooLargeMessage({
                category: detectedCategory,
                actualBytes: mediaFile.size,
                limitMB,
                alternative: detectedCategory === 'video'
                    ? `Videos in chat are capped lower than posts — you can share this as a post instead, up to ${POST_MEDIA_LIMITS_MB.video} MB.`
                    : undefined,
            }));
        }

        const folderMap = {
            image: 'chat_images',
            video: 'chat_videos',
            audio: 'chat_audio',
            file: 'chat_files',
        };

        try {
            const uploadResult = await uploadBufferToBunny(
                mediaFile.buffer,
                folderMap[detectedCategory],
                mediaFile.originalname,
                mediaFile.mimetype
            );
            messageData.mediaUrl = uploadResult.secure_url;
            messageData.fileName = mediaFile.originalname;
            messageData.fileSize = mediaFile.size;

            if (uploadResult.duration) {
                messageData.duration = uploadResult.duration;
            }

            if (messageType === 'text') {
                const categoryToMsgType = {
                    image: 'image',
                    video: 'video',
                    audio: 'audio',
                    file: 'file',
                };
                messageData.messageType = categoryToMsgType[detectedCategory];
            }
        } catch (uploadError) {
            throw new ApiError(500, `Failed to upload media file: ${uploadError.message}`);
        }
    }

    const newMessage = await Message.create(messageData);

    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: currentUserId,
        message: viewOnce ? previewLabel(messageData.messageType, { viewOnce: true }) : finalMessage,
        messageType: messageData.messageType,
        timestamp: new Date()
    };
    chat.lastMessageId = newMessage._id;
    await chat.save();

    const populatedMessage = await Message.findById(newMessage._id)
        .populate('sender', 'username fullName profileImageUrl')
        .populate({
            path: 'replyTo',
            select: 'message sender timestamp',
            populate: {
                path: 'sender',
                select: 'username fullName'
            }
        })
        .lean();

    // First encrypted message in this chat: mark it and say so (#2).
    if (e2eeEnvelope && !chat.e2ee?.enabled) {
        await markChatEncrypted(chat, currentUserId);
    }

    const outgoing = viewOnce ? redactViewOnce(populatedMessage, null) : populatedMessage;

    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: outgoing
    });

    if (sharedPost) {
        // Counted like any other share; fire-and-forget, never fails the send.
        recordPostShare(sharedPost.postId, currentUserId);
    }

    (async () => {
        try {
            // Participants who muted this chat get no push (#38). The message
            // itself, unread counts and socket events are unaffected.
            const otherParticipants = chat.participants.filter(
                participantId => participantId.toString() !== currentUserId.toString()
                    && !isChatMutedFor(chat, participantId)
            );

            if (otherParticipants.length > 0) {
                const sender = await User.findById(currentUserId).select('username fullName profileImageUrl');
                const senderName = sender?.fullName || sender?.username || 'Unknown User';
                // Carried in the FCM data so tapping the notification can open
                // the conversation with a populated header. The chat screen
                // renders the name/avatar straight from its route arguments and
                // does not fetch them, so without these the header would be
                // blank on a notification-launched open.
                const senderAvatar = sender?.profileImageUrl || '';

                // Encrypted text can't be previewed by the server (#2), and a
                // view-once photo shouldn't be described by its file name.
                const lockedBody = isEncrypted
                    ? (viewOnce ? '🔒 View-once media' : '🔒 New message')
                    : viewOnce
                        ? previewLabel(messageData.messageType, { viewOnce: true })
                        : gif
                            ? `Sent a ${messageType === 'sticker' ? 'sticker' : 'GIF'}`
                            : null;

                const notificationData = {
                    title: `New message from ${senderName}`,
                    // A story reply carries real text — an emoji or a typed
                    // line — so it reads like a message, not like an
                    // attachment. Without this case it fell into the final
                    // branch and pushed "Sent a file", which describes nothing
                    // that happened.
                    body: lockedBody ? lockedBody : messageType === 'shared_post'
                        ? (message && message.trim() ? `${sharedPostSummary(sharedPost)}: ${finalMessage.length > 40 ? finalMessage.substring(0, 40) + '…' : finalMessage}` : sharedPostSummary(sharedPost))
                        : (messageType === 'text' || messageType === 'story_reply')
                        ? (messageType === 'story_reply'
                            ? `Replied to your story: ${finalMessage.length > 40 ? finalMessage.substring(0, 40) + '…' : finalMessage}`
                            : finalMessage.length > 50 ? finalMessage.substring(0, 50) + '...' : finalMessage)
                        : `Sent ${messageType === 'image' ? 'an image' : messageType === 'video' ? 'a video' : messageType === 'audio' ? 'an audio' : 'a file'}`,
                    chatId: chatId,
                    messageId: newMessage._id.toString(),
                    senderId: currentUserId.toString(),
                    url: `/chats?chatId=${chatId}`
                };

                // Web-push (VAPID) for logged-in WEBSITE users.
                await sendPushNotification(otherParticipants, notificationData);

                // FCM push for MOBILE devices. The mobile app stores its device
                // token on User.fcmToken (not in PushSubscription), so the
                // web-push path above never reaches it — send FCM explicitly.
                // Every device of every recipient, including phones that hold
                // several accounts (#25); each push names the account it's for.
                const targets = await getPushTargets(otherParticipants);
                await sendFcmToTargets(targets, {
                    title: notificationData.title,
                    body: notificationData.body,
                    type: 'message',
                    data: {
                        chatId: notificationData.chatId,
                        messageId: notificationData.messageId,
                        senderId: notificationData.senderId,
                        senderName: String(senderName),
                        senderAvatar: String(senderAvatar),
                        url: notificationData.url,
                        e2ee: isEncrypted ? '1' : undefined
                    }
                });
            }
        } catch (pushError) {
            console.error('Error sending push notification:', pushError);
        }
    })();

    (async () => {
        try {
            const participantIds = chat.participants.map(p => p.toString());
            await notificationCache.invalidateMultipleUsersCache(participantIds, 'message');

            const cacheInvalidations = [];
            for (const participantId of participantIds) {
                for (let page = 1; page <= 3; page++) {
                    const activeKey = `chats:user:${participantId}:status:active:page:${page}:limit:20`;
                    const requestedKey = `chats:user:${participantId}:status:requested:page:${page}:limit:20`;
                    cacheInvalidations.push(
                        redisClient.del(activeKey),
                        redisClient.del(requestedKey)
                    );
                }
            }
            await Promise.all(cacheInvalidations);
        } catch (cacheError) {
            console.error('Error invalidating caches:', cacheError);
        }
    })();

    return res.status(201).json(
        new ApiResponse(201, viewOnce ? redactViewOnce(populatedMessage, currentUserId) : populatedMessage, 'Message sent successfully')
    );
});

export const markMessagesRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { messageIds } = req.body;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const currentTime = new Date();

    if (messageIds && Array.isArray(messageIds)) {
        await Message.updateMany(
            {
                _id: { $in: messageIds },
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId },
                $set: {
                    'deliveryStatus.$[elem].status': 'seen',
                    'deliveryStatus.$[elem].seenAt': currentTime
                }
            },
            {
                arrayFilters: [{ 'elem.userId': currentUserId }]
            }
        );
    } else {
        await Message.updateMany(
            {
                chatId,
                readBy: { $ne: currentUserId }
            },
            {
                $addToSet: { readBy: currentUserId },
                $set: {
                    'deliveryStatus.$[elem].status': 'seen',
                    'deliveryStatus.$[elem].seenAt': currentTime
                }
            },
            {
                arrayFilters: [{ 'elem.userId': currentUserId }]
            }
        );
    }

    safeEmitToChat(chatId, 'messages_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    try {
        await notificationCache.invalidateMessageCache(currentUserId.toString());

        const cacheInvalidations = [];
        for (let page = 1; page <= 3; page++) {
            const activeKey = `chats:user:${currentUserId}:status:active:page:${page}:limit:20`;
            const requestedKey = `chats:user:${currentUserId}:status:requested:page:${page}:limit:20`;
            cacheInvalidations.push(
                redisClient.del(activeKey),
                redisClient.del(requestedKey)
            );
        }
        await Promise.all(cacheInvalidations);
    } catch (cacheError) {
        console.error('Error invalidating message cache:', cacheError);
    }

    return res.status(200).json(
        new ApiResponse(200, {}, 'Messages marked as read')
    );
});

export const markChatAsRead = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const result = await Message.updateMany(
        {
            chatId,
            readBy: { $ne: currentUserId },
            isDeleted: { $ne: true }
        },
        {
            $addToSet: { readBy: currentUserId }
        }
    );

    safeEmitToChat(chatId, 'chat_marked_as_read', {
        chatId,
        readBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    try {
        await notificationCache.invalidateMessageCache(currentUserId.toString());

        const cacheInvalidations = [];
        for (let page = 1; page <= 3; page++) {
            const activeKey = `chats:user:${currentUserId}:status:active:page:${page}:limit:20`;
            const requestedKey = `chats:user:${currentUserId}:status:requested:page:${page}:limit:20`;
            cacheInvalidations.push(
                redisClient.del(activeKey),
                redisClient.del(requestedKey)
            );
        }
        await Promise.all(cacheInvalidations);
    } catch (cacheError) {
        console.error('Error invalidating message cache:', cacheError);
    }

    return res.status(200).json(
        new ApiResponse(200, {
            updatedCount: result.modifiedCount
        }, 'Chat marked as read')
    );
});

export const searchMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { query, page = 1, limit = 20 } = req.query;

    if (!query || query.trim().length === 0) {
        throw new ApiError(400, 'Search query is required');
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageLimit = Math.min(Math.max(1, parseInt(limit) || 20), MAX_MESSAGE_PAGE_LIMIT);
    const skip = (pageNum - 1) * pageLimit;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    // The search term went into $regex verbatim, so the caller chose the pattern
    // the database compiled: ordinary punctuation ("(((") threw or matched the
    // wrong things, and a backtracking pattern like (a+)+$ pinned a CPU core
    // against every message in the chat — twice, once for find and once for the
    // count. Escaped, it can only ever be a literal substring match.
    const searchPattern = escapeRegex(query.trim());
    const searchFilter = {
        chatId,
        message: { $regex: searchPattern, $options: 'i' },
        isDeleted: { $ne: true },
        // Encrypted messages can't be searched on the server (#2), and
        // disappeared or view-once ones must not resurface here.
        messageType: { $nin: ['encrypted', 'system'] },
        viewOnce: { $ne: true },
        $and: [notExpiredFilter()]
    };

    const [searchResults, totalResults] = await Promise.all([
        Message.find(searchFilter)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pageLimit)
            .select('sender message messageType timestamp')
            .populate('sender', 'username fullName profileImageUrl')
            .lean(),
        Message.countDocuments(searchFilter)
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            messages: searchResults,
            query,
            totalResults,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(totalResults / pageLimit),
                hasNextPage: pageNum < Math.ceil(totalResults / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Search completed successfully')
    );
});
