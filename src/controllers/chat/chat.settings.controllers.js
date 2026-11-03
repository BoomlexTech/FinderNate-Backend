import Chat from '../../models/chat.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import socketManager from '../../config/socket.js';
import { getPrivacyFilteredStatus } from '../../middlewares/messaging-privacy.middleware.js';
import { safeEmitToChat, safeEmitToUser, MUTE_DURATIONS, muteFieldsFor } from './helpers.js';
import mongoose from 'mongoose';
import { redisClient } from '../../config/redis.config.js';
import { uploadBufferToBunny } from '../../utils/bunny.js';
import { checkGroupPermission } from '../../utils/chatRoles.rules.js';

export const updateChatTheme = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { themeColor } = req.body;

    if (!themeColor) {
        throw new ApiError(400, 'Theme color is required');
    }

    if (!/^#[0-9A-F]{6}$/i.test(themeColor)) {
        throw new ApiError(400, 'Invalid color format. Use hex color code (e.g., #DBB42C)');
    }

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    chat.themeColor = themeColor;
    await chat.save();

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    safeEmitToChat(chatId, 'chat_theme_updated', {
        chatId,
        themeColor,
        updatedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedChat, 'Chat theme updated successfully')
    );
});

/**
 * Set or replace a group's image.
 *
 * The Chat model has always had a `groupImage` field but nothing could write
 * to it, so groups were stuck with the generic placeholder. Restricted to
 * group admins — any participant being able to change the picture everyone
 * sees is a small but real abuse vector.
 *
 * Send `multipart/form-data` with a `groupImage` file, or JSON
 * `{ "groupImage": null }` to clear it.
 */
export const updateGroupImage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats have a group image');
    }

    // Owner or admin (Phase 3 #21).
    if (checkGroupPermission(chat, currentUserId, 'edit_info')) {
        throw new ApiError(403, 'Only the group owner and admins can change the group image');
    }

    //* Explicit removal: { groupImage: null } with no file attached.
    if (!req.file) {
        if (req.body?.groupImage === null || req.body?.groupImage === 'null' || req.body?.groupImage === '') {
            chat.groupImage = undefined;
            await chat.save();
            safeEmitToChat(chatId, 'group_image_updated', { chatId, groupImage: null, updatedBy: currentUserId });
            return res.status(200).json(new ApiResponse(200, { groupImage: null }, 'Group image removed'));
        }
        throw new ApiError(400, 'No image supplied');
    }

    if (!String(req.file.mimetype || '').startsWith('image/')) {
        throw new ApiError(400, 'Group image must be an image file');
    }

    const uploaded = await uploadBufferToBunny(
        req.file.buffer,
        'chat-groups',
        req.file.originalname,
        req.file.mimetype,
    );

    chat.groupImage = uploaded.secure_url;
    await chat.save();

    //* Tell everyone in the room, so open clients update without a refetch.
    safeEmitToChat(chatId, 'group_image_updated', {
        chatId,
        groupImage: chat.groupImage,
        updatedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName,
        },
    });

    return res.status(200).json(
        new ApiResponse(200, { chatId, groupImage: chat.groupImage }, 'Group image updated successfully')
    );
});

/**
 * Rename a group.
 *
 * Restricted to group admins, same as updateGroupImage. Broadcasts a
 * room-only event (not a per-participant emit) since a rename is a
 * low-stakes cosmetic change.
 */
export const updateGroupName = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const { groupName } = req.body;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats can be renamed');
    }

    // Owner or admin (Phase 3 #21).
    if (checkGroupPermission(chat, currentUserId, 'edit_info')) {
        throw new ApiError(403, 'Only the group owner and admins can rename the group');
    }

    if (!groupName || !groupName.trim()) {
        throw new ApiError(400, 'Group name is required');
    }

    chat.groupName = groupName.trim();
    await chat.save();

    safeEmitToChat(chatId, 'group_name_updated', {
        chatId,
        groupName: chat.groupName,
        updatedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName,
        },
    });

    return res.status(200).json(
        new ApiResponse(200, { chatId, groupName: chat.groupName }, 'Group renamed successfully')
    );
});

export const startTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    safeEmitToChat(chatId, 'user_typing', {
        userId: currentUserId,
        username: req.user.username,
        fullName: req.user.fullName,
        chatId
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Typing indicator started')
    );
});

export const stopTyping = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    safeEmitToChat(chatId, 'user_stopped_typing', {
        userId: currentUserId,
        chatId
    });

    return res.status(200).json(
        new ApiResponse(200, {}, 'Typing indicator stopped')
    );
});

export const getOnlineStatus = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    let userIds = req.query.userIds;

    if (typeof userIds === 'string') {
        if (userIds.includes(',')) {
            userIds = userIds.split(',');
        } else {
            userIds = [userIds];
        }
    }

    if (!userIds || !Array.isArray(userIds)) {
        throw new ApiError(400, "User IDs array is required");
    }

    const onlineStatus = {};

    for (const userId of userIds) {
        const status = await getPrivacyFilteredStatus(
            currentUserId,
            userId,
            socketManager.isUserOnline.bind(socketManager)
        );
        onlineStatus[userId] = status;
    }

    return res.status(200).json(
        new ApiResponse(200, { onlineStatus }, 'Online status fetched successfully')
    );
});


/* ------------------------------ chat mute (#38) ----------------------------- */

// The chat list is cached per user and page (see getUserChats); drop the pages
// that carry the mute icon so it shows up straight away.
const invalidateChatListCache = async (userId) => {
    const keys = [];
    for (let page = 1; page <= 3; page++) {
        keys.push(`chats:user:${userId}:status:active:page:${page}:limit:20`);
        keys.push(`chats:user:${userId}:status:requested:page:${page}:limit:20`);
    }
    await Promise.allSettled(keys.map((key) => redisClient.del(key)));
};

/**
 * PATCH /chats/:chatId/mute   body: { duration: '8h' | '1w' | 'always' }
 *
 * Mutes push notifications from this chat for the caller only (Phase 2 #38).
 * Messages still arrive, unread counts still count, and nobody else is told.
 * Muting again replaces the previous duration.
 */
export const muteChat = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;
    const duration = req.body?.duration ?? 'always';

    if (!Object.prototype.hasOwnProperty.call(MUTE_DURATIONS, duration)) {
        throw new ApiError(400, "duration must be '8h', '1w' or 'always'");
    }
    if (!mongoose.isValidObjectId(chatId)) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    const ms = MUTE_DURATIONS[duration];
    const until = ms === null ? null : new Date(Date.now() + ms);
    const filter = { _id: chatId, participants: currentUserId };

    // Two plain updates rather than load-and-save, so an old chat document that
    // fails today's validators cannot block a mute.
    const cleared = await Chat.updateOne(filter, { $pull: { mutes: { userId: currentUserId }, mutedBy: currentUserId } });
    if (cleared.matchedCount === 0) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    await Chat.updateOne(filter, { $push: { mutes: { userId: currentUserId, until } } });

    const state = muteFieldsFor({ mutes: [{ userId: currentUserId, until }] }, currentUserId);
    await invalidateChatListCache(currentUserId);
    // The caller's other signed-in devices update their mute icon too.
    safeEmitToUser(currentUserId, 'chat_mute_updated', { chatId, ...state });

    return res.status(200).json(new ApiResponse(200, { chatId, ...state }, 'Chat notifications muted'));
});

/** DELETE /chats/:chatId/mute — turns notifications for this chat back on (#38). */
export const unmuteChat = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    if (!mongoose.isValidObjectId(chatId)) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    const result = await Chat.updateOne(
        { _id: chatId, participants: currentUserId },
        { $pull: { mutes: { userId: currentUserId }, mutedBy: currentUserId } }
    );
    if (result.matchedCount === 0) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }

    const state = { isMuted: false, mutedUntil: null };
    await invalidateChatListCache(currentUserId);
    safeEmitToUser(currentUserId, 'chat_mute_updated', { chatId, ...state });

    return res.status(200).json(new ApiResponse(200, { chatId, ...state }, 'Chat notifications unmuted'));
});
