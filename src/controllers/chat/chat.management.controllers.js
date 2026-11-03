import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import mongoose from 'mongoose';
import socketManager from '../../config/socket.js';
import { redisClient } from '../../config/redis.config.js';
import { safeEmitToChat, safeEmitToUser, checkFollowStatus, assertNotBlockedInChat, getBlockedParticipantIds, muteFieldsFor } from './helpers.js';

export const createChat = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { participants, chatType = 'direct', groupName, groupDescription, productContext } = req.body;

    if (!participants || !Array.isArray(participants) || participants.length < 2) {
        throw new ApiError(400, 'At least two participants required');
    }

    if (!participants.includes(currentUserId.toString())) {
        participants.push(currentUserId.toString());
    }

    const validParticipants = participants
        .filter(p => mongoose.Types.ObjectId.isValid(p))
        .map(p => new mongoose.Types.ObjectId(p));

    if (validParticipants.length !== participants.length) {
        throw new ApiError(400, 'Invalid participant IDs');
    }

    if (chatType === 'direct' && validParticipants.length !== 2) {
        throw new ApiError(400, 'Direct chats must have exactly 2 participants');
    }

    // A group is three people or more — the creator plus at least two others.
    // Two people is a direct chat, which has its own type above.
    //
    // The message says what to DO. It previously read "Group chats must have
    // at least 3 participants", which counts the creator, so someone who had
    // ticked two members could reasonably think they had satisfied it. The
    // client also blocks this before submitting; this is the backstop.
    if (chatType === 'group' && validParticipants.length < 3) {
        throw new ApiError(400, 'Add at least 2 members to create a group (3 people including you)');
    }

    validParticipants.sort((a, b) => a.toString().localeCompare(b.toString()));

    // No new (or reopened) direct conversation with someone either side has
    // blocked. Group chats are exempt: one block between two members must not
    // stop everyone else forming a group.
    if (chatType === 'direct') {
        await assertNotBlockedInChat(currentUserId, validParticipants, 'send');
    }

    if (chatType === 'direct') {
        const existingChat = await Chat.findOne({
            chatType: 'direct',
            participants: { $all: validParticipants, $size: 2 }
        });

        if (existingChat) {
            const otherUserId = validParticipants.find(id => id.toString() !== currentUserId.toString());
            const recipientFollowsSender = await checkFollowStatus(otherUserId, currentUserId);

            if (!recipientFollowsSender && existingChat.status === 'active') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId;
            } else if (recipientFollowsSender && existingChat.status === 'requested') {
                existingChat.status = 'active';
            } else if (existingChat.status === 'declined') {
                existingChat.status = 'requested';
                existingChat.createdBy = currentUserId;
            }

            const lastMessage = await Message.findOne({
                chatId: existingChat._id,
                isDeleted: { $ne: true }
            }).sort({ timestamp: -1 });

            const messageCount = await Message.countDocuments({
                chatId: existingChat._id,
                isDeleted: { $ne: true }
            });

            if (lastMessage) {
                existingChat.lastMessage = {
                    sender: lastMessage.sender,
                    message: lastMessage.message,
                    timestamp: lastMessage.timestamp
                };
                existingChat.lastMessageId = lastMessage._id;
                existingChat.lastMessageAt = lastMessage.timestamp;
            } else {
                existingChat.lastMessage = {};
                existingChat.lastMessageId = null;
                existingChat.lastMessageAt = existingChat.createdAt;
            }

            if (!existingChat.stats) {
                existingChat.stats = {};
            }
            existingChat.stats.totalMessages = messageCount;
            existingChat.stats.totalParticipants = existingChat.participants.length;

            await existingChat.save();

            const populatedChat = await Chat.findById(existingChat._id)
                .populate('participants', 'username fullName profileImageUrl')
                .populate('createdBy', 'username fullName profileImageUrl');

            const unreadCount = await Message.countDocuments({
                chatId: existingChat._id,
                isDeleted: { $ne: true },
                readBy: { $ne: currentUserId }
            });
            populatedChat.unreadCount = unreadCount;

            return res.status(200).json(
                new ApiResponse(200, populatedChat, 'Existing chat found')
            );
        }
    }

    const chatData = {
        participants: validParticipants,
        chatType,
        createdBy: currentUserId
    };

    if (chatType === 'direct' && validParticipants.length === 2) {
        const otherUserId = validParticipants.find(id => id.toString() !== currentUserId.toString());
        const recipientFollowsSender = await checkFollowStatus(otherUserId, currentUserId);
        if (!recipientFollowsSender) {
            chatData.status = 'requested';
        }
    }

    if (chatType === 'group') {
        if (!groupName) {
            throw new ApiError(400, 'Group name is required for group chats');
        }
        chatData.groupName = groupName;
        chatData.groupDescription = groupDescription;
        chatData.admins = [currentUserId];
    }

    if (productContext) {
        chatData.productContext = productContext;
    }

    const chat = await Chat.create(chatData);
    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    return res.status(201).json(
        new ApiResponse(201, populatedChat, 'Chat created successfully')
    );
});

export const getUserChats = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { page = 1, limit = 20, chatStatus = 'active' } = req.query;

    const userObjectId = new mongoose.Types.ObjectId(currentUserId);
    const pageNum = parseInt(page) || 1;
    const pageLimit = Math.min(parseInt(limit) || 20, 50);
    const skip = (pageNum - 1) * pageLimit;

    const cacheKey = `chats:user:${currentUserId}:status:${chatStatus}:page:${pageNum}:limit:${pageLimit}`;
    try {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.status(200).json(JSON.parse(cachedData));
        }
    } catch (cacheError) {
        console.error('Cache read error:', cacheError);
    }

    const statusFilter = ['active', 'requested'].includes(chatStatus) ? chatStatus : 'active';

    // createChat() and the first addMessage() are separate calls (get-or-create
    // the chat, then navigate in and let the user type). If the sender never
    // actually sends anything — backs out, the app is killed, the request
    // drops — the chat document still exists with zero messages, and used to
    // surface as a blank "message request" on the recipient's side with
    // nothing to show. lastMessageId is only ever set by addMessage (see
    // message.controllers.js), never at creation, so requiring it here hides
    // a chat from both list views until a real message exists. This is a pure
    // read-side filter — it fixes every chat stuck in this state retroactively,
    // no backfill needed — and does not affect opening a chat you just
    // created, since that navigates straight to the chatId the create call
    // returned rather than looking it up in this list.
    let chatFilter;
    if (statusFilter === 'requested') {
        chatFilter = {
            participants: { $in: [userObjectId] },
            status: 'requested',
            createdBy: { $ne: userObjectId },
            lastMessageId: { $ne: null }
        };
    } else {
        chatFilter = {
            participants: { $in: [userObjectId] },
            lastMessageId: { $ne: null },
            $or: [
                { status: 'active' },
                { status: 'requested', createdBy: userObjectId }
            ]
        };
    }

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
    }

    const [chats, total] = await Promise.all([
        Chat.find(chatFilter)
            .select('+mutes')
            .sort({ lastMessageAt: -1 })
            .skip(skip)
            .limit(pageLimit)
            .lean(),
        Chat.countDocuments(chatFilter)
    ]);

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
    }

    const secureChats = chats.filter(chat =>
        chat.participants.some(participantId =>
            participantId.toString() === currentUserId.toString()
        )
    );

    const deduplicatedChats = [];
    const seenParticipants = new Map();

    for (const chat of secureChats) {
        if (chat.chatType === 'direct' && chat.participants.length === 2) {
            const participantKey = chat.participants
                .map(p => p.toString())
                .sort()
                .join(',');

            const existingChat = seenParticipants.get(participantKey);

            if (!existingChat) {
                seenParticipants.set(participantKey, chat);
                deduplicatedChats.push(chat);
            } else {
                const existingTimestamp = existingChat.lastMessageAt?.getTime() || existingChat.createdAt?.getTime() || 0;
                const currentTimestamp = chat.lastMessageAt?.getTime() || chat.createdAt?.getTime() || 0;

                if (currentTimestamp > existingTimestamp) {
                    const indexToReplace = deduplicatedChats.indexOf(existingChat);
                    if (indexToReplace !== -1) {
                        deduplicatedChats[indexToReplace] = chat;
                        seenParticipants.set(participantKey, chat);
                    }
                }
                if (process.env.NODE_ENV === 'development' && !global._chatDuplicatesWarned) {
                    global._chatDuplicatesWarned = true;
                }
            }
        } else {
            deduplicatedChats.push(chat);
        }
    }

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_CHAT === 'true') {
        if (chats.length !== secureChats.length) {
            console.warn(`Security filter removed ${chats.length - secureChats.length} unauthorized chats for user ${currentUserId}`);
        }
        if (secureChats.length !== deduplicatedChats.length && !global._chatDuplicatesWarned) {
            console.warn(`⚠️ Deduplication removed ${secureChats.length - deduplicatedChats.length} duplicate chats. Run: node src/scripts/cleanupDuplicateChats.js`);
            global._chatDuplicatesWarned = true;
        }
    }

    const chatIds = deduplicatedChats.map(chat => chat._id);

    const lastMessagesPromises = chatIds.map(chatId =>
        Message.findOne({
            chatId,
            $and: [
                { deletedForEveryone: { $ne: true } },
                { 'deletedFor.userId': { $ne: userObjectId } }
            ]
        })
            .sort({ timestamp: -1 })
            .populate('sender', 'username fullName profileImageUrl')
    );

    const lastMessages = await Promise.all(lastMessagesPromises);

    const lastMessageMap = lastMessages.reduce((acc, message, index) => {
        if (message) {
            acc[chatIds[index].toString()] = {
                message,
                lastMessage: {
                    sender: message.sender,
                    message: message.message,
                    timestamp: message.timestamp
                }
            };
        }
        return acc;
    }, {});

    const chatStats = await Message.aggregate([
        {
            $match: {
                chatId: { $in: chatIds },
                $and: [
                    { deletedForEveryone: { $ne: true } },
                    { 'deletedFor.userId': { $ne: userObjectId } }
                ]
            }
        },
        {
            $group: {
                _id: '$chatId',
                totalMessages: { $sum: 1 },
                unreadCount: {
                    $sum: {
                        $cond: [
                            { $not: { $in: [userObjectId, '$readBy'] } },
                            1,
                            0
                        ]
                    }
                }
            }
        }
    ]);

    const unreadCountMap = {};
    const messageCountMap = {};

    chatStats.forEach(item => {
        const chatIdStr = item._id.toString();
        unreadCountMap[chatIdStr] = item.unreadCount;
        messageCountMap[chatIdStr] = item.totalMessages;
    });

    // Everyone this viewer shares a direct chat with, resolved in ONE query,
    // so the per-chat filter below costs nothing extra.
    const directCounterpartIds = deduplicatedChats
        .filter(chat => chat.chatType === 'direct')
        .flatMap(chat => chat.participants.map(p => p.toString()));
    const blockedParticipantIds = await getBlockedParticipantIds(currentUserId, directCounterpartIds);

    const populatedChatsPromise = Promise.all(deduplicatedChats.map(async (chat) => {
        const chatWithUsers = await Chat.populate(chat, [
            { path: 'participants', select: 'username fullName profileImageUrl accountStatus isDeleted' },
            { path: 'createdBy', select: 'username fullName profileImageUrl' }
        ]);

        if (chatWithUsers.chatType === 'direct') {
            const otherParticipant = chatWithUsers.participants.find(
                p => p._id.toString() !== currentUserId.toString()
            );
            if (otherParticipant && (otherParticipant.isDeleted || otherParticipant.accountStatus !== 'active')) {
                return null;
            }
            // A blocked pair's conversation is not listed on either side. Both
            // controllers that open it now refuse, so leaving the row in the
            // list would only offer a thread that answers 403 when tapped.
            if (otherParticipant && blockedParticipantIds.has(otherParticipant._id.toString())) {
                return null;
            }
        }

        chatWithUsers.participants = chatWithUsers.participants.map(p => ({
            _id: p._id,
            username: p.username,
            fullName: p.fullName,
            profileImageUrl: p.profileImageUrl || null
        }));

        const chatId = chat._id.toString();
        let needsDbUpdate = false;

        if (lastMessageMap[chatId]) {
            const latestMessage = lastMessageMap[chatId].message;
            chatWithUsers.lastMessage = lastMessageMap[chatId].lastMessage;
            chatWithUsers.lastMessageId = latestMessage._id;

            if (!chat.lastMessageId ||
                chat.lastMessageId.toString() !== latestMessage._id.toString() ||
                !chat.lastMessage?.message) {
                needsDbUpdate = true;
            }
        } else {
            chatWithUsers.lastMessage = {};
            chatWithUsers.lastMessageId = null;
            chatWithUsers.lastMessageAt = chat.createdAt;

            if (chat.lastMessageId ||
                (chat.lastMessage && Object.keys(chat.lastMessage).length > 0)) {
                needsDbUpdate = true;
            }
        }

        if (needsDbUpdate) {
            const updateData = lastMessageMap[chatId] ? {
                lastMessage: lastMessageMap[chatId].lastMessage,
                lastMessageId: lastMessageMap[chatId].message._id,
                lastMessageAt: lastMessageMap[chatId].message.timestamp
            } : {
                lastMessage: {},
                lastMessageId: null,
                lastMessageAt: chat.createdAt
            };

            Chat.findByIdAndUpdate(chat._id, updateData).catch(err =>
                console.error('Failed to update chat metadata:', err)
            );
        }

        if (!chatWithUsers.stats) {
            chatWithUsers.stats = {};
        }
        chatWithUsers.stats.totalMessages = messageCountMap[chatId] || 0;
        chatWithUsers.stats.totalParticipants = chatWithUsers.participants.length;
        chatWithUsers.unreadCount = unreadCountMap[chatId] || 0;

        // The caller's own mute state only (#38); other people's mutes stay private.
        Object.assign(chatWithUsers, muteFieldsFor(chat, currentUserId));
        delete chatWithUsers.mutes;
        delete chatWithUsers.mutedBy;

        return chatWithUsers;
    }));

    const populatedChats = (await populatedChatsPromise).filter(Boolean);

    const deduplicatedTotal = deduplicatedChats.length;
    const actualTotal = total;

    if (socketManager.isReady()) {
        const userSocketId = socketManager.connectedUsers.get(currentUserId.toString());
        if (userSocketId) {
            const io = socketManager.io;
            const socket = io.sockets.sockets.get(userSocketId);
            if (socket) {
                populatedChats.forEach(chat => {
                    if (!chat) return;
                    const chatId = chat._id.toString();
                    socket.join(`chat:${chatId}`);
                    socket.chatRooms = socket.chatRooms || new Set();
                    socket.chatRooms.add(chatId);
                });
            }
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            chats: populatedChats,
            chatStatus: statusFilter,
            pagination: {
                currentPage: pageNum,
                totalPages: Math.ceil(actualTotal / pageLimit),
                totalChats: actualTotal,
                deduplicatedChatsReturned: deduplicatedTotal,
                hasNextPage: pageNum < Math.ceil(actualTotal / pageLimit),
                hasPrevPage: pageNum > 1
            }
        }, 'Chats fetched successfully')
    );
});

export const acceptChatRequest = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId,
        status: 'requested'
    });

    if (!chat) {
        throw new ApiError(404, 'Chat request not found or already processed');
    }

    if (chat.createdBy.toString() === currentUserId.toString()) {
        throw new ApiError(400, 'You cannot accept your own chat request');
    }

    chat.status = 'active';
    await chat.save();

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    safeEmitToChat(chatId, 'chat_request_accepted', {
        chatId,
        acceptedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        },
        chat: populatedChat
    });

    return res.status(200).json(
        new ApiResponse(200, populatedChat, 'Chat request accepted successfully')
    );
});

export const declineChatRequest = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId,
        status: 'requested'
    });

    if (!chat) {
        throw new ApiError(404, 'Chat request not found or already processed');
    }

    if (chat.createdBy.toString() === currentUserId.toString()) {
        throw new ApiError(400, 'You cannot decline your own chat request');
    }

    chat.status = 'declined';
    await chat.save();

    safeEmitToChat(chatId, 'chat_request_declined', {
        chatId,
        declinedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, { chatId }, 'Chat request declined successfully')
    );
});

/**
 * Removes another participant from a group. Admin-only.
 *
 * The group had a member list with Admin/Creator badges and no way to act on
 * it — no route existed to remove anyone, on either client. This is that
 * route; the creator is exempt (they can only leave, via leaveGroup below,
 * which promotes a replacement admin) so a group can never end up with no one
 * able to manage it.
 */
export const removeGroupMember = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, memberId } = req.params;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats have members to remove');
    }

    const isAdmin = (chat.admins || []).some(a => String(a) === String(currentUserId))
        || String(chat.createdBy) === String(currentUserId);
    if (!isAdmin) {
        throw new ApiError(403, 'Only group admins can remove members');
    }

    if (String(memberId) === String(currentUserId)) {
        throw new ApiError(400, 'Use "Leave group" to remove yourself');
    }
    if (String(memberId) === String(chat.createdBy)) {
        throw new ApiError(403, 'The group creator cannot be removed');
    }
    if (!chat.participants.some(p => String(p) === String(memberId))) {
        throw new ApiError(404, 'That user is not a member of this group');
    }

    chat.participants = chat.participants.filter(p => String(p) !== String(memberId));
    chat.admins = (chat.admins || []).filter(a => String(a) !== String(memberId));
    chat.stats = chat.stats || {};
    chat.stats.totalParticipants = chat.participants.length;
    await chat.save();

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', 'username fullName profileImageUrl')
        .populate('createdBy', 'username fullName profileImageUrl');

    const removedBy = {
        _id: currentUserId,
        username: req.user.username,
        fullName: req.user.fullName
    };

    //* To the remaining members, so their member list updates without a refetch.
    safeEmitToChat(chatId, 'group_member_removed', { chatId, memberId, removedBy });
    //* Direct to the removed member too — they are no longer in the chat room
    //* (their existing socket connection stays joined to it until they next
    //* reconnect, but they can no longer fetch this chat's messages or member
    //* list via the API, since both require participants membership), so
    //* emitToChat above would never reach them.
    safeEmitToUser(memberId, 'removed_from_group', { chatId, groupName: chat.groupName, removedBy });

    return res.status(200).json(
        new ApiResponse(200, populatedChat, 'Member removed successfully')
    );
});

/**
 * Leaves a group. Any participant, including the creator, may call this.
 *
 * If the leaver was the last admin, the longest-standing remaining member is
 * promoted so the group is never left with nobody able to manage it. If the
 * leaver was the last participant, the chat is kept (empty, inactive) rather
 * than deleted — consistent with how the rest of this app never hard-deletes
 * a record just because it became empty.
 */
export const leaveGroup = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats can be left');
    }

    chat.participants = chat.participants.filter(p => String(p) !== String(currentUserId));
    chat.admins = (chat.admins || []).filter(a => String(a) !== String(currentUserId));

    let promoted = null;
    if (chat.admins.length === 0 && chat.participants.length > 0) {
        promoted = chat.participants[0];
        chat.admins = [promoted];
    }

    chat.stats = chat.stats || {};
    chat.stats.totalParticipants = chat.participants.length;
    await chat.save();

    const leftBy = {
        _id: currentUserId,
        username: req.user.username,
        fullName: req.user.fullName
    };

    safeEmitToChat(chatId, 'group_member_left', { chatId, leftBy, promotedAdminId: promoted });

    return res.status(200).json(
        new ApiResponse(200, { chatId, promotedAdminId: promoted }, 'You have left the group')
    );
});

/**
 * Deletes an entire group — destroys it for every member, not just the caller.
 * Admin-only (same admin check as removeGroupMember).
 *
 * Unlike leaveGroup, which keeps an emptied-out chat around rather than
 * hard-deleting it, this is an explicit, admin-initiated destruction of the
 * whole group: the Chat document and all of its messages are removed.
 */
export const deleteGroup = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({ _id: chatId, participants: currentUserId });
    if (!chat) {
        throw new ApiError(404, 'Chat not found or you are not a participant');
    }
    if (chat.chatType !== 'group') {
        throw new ApiError(400, 'Only group chats can be deleted this way');
    }

    const isAdmin = (chat.admins || []).some(a => String(a) === String(currentUserId))
        || String(chat.createdBy) === String(currentUserId);
    if (!isAdmin) {
        throw new ApiError(403, 'Only group admins can delete the group');
    }

    const participantIds = chat.participants.map(p => p.toString());
    const groupName = chat.groupName;

    await Message.deleteMany({ chatId: chat._id });
    await Chat.findByIdAndDelete(chat._id);

    (async () => {
        try {
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

    const deletedBy = {
        _id: currentUserId,
        username: req.user.username,
        fullName: req.user.fullName
    };

    //* To anyone whose socket is still joined to the chat room.
    safeEmitToChat(chatId, 'group_deleted', { chatId, groupName, deletedBy });
    //* Direct to every other participant too — mirrors removeGroupMember's
    //* removed_from_group: a participant's socket may or may not still be
    //* joined to the chat room at this point, so the direct emit is the
    //* reliable path regardless.
    participantIds
        .filter(participantId => participantId !== String(currentUserId))
        .forEach(participantId => {
            safeEmitToUser(participantId, 'group_deleted', { chatId, groupName, deletedBy });
        });

    return res.status(200).json(
        new ApiResponse(200, { chatId }, 'Group deleted successfully')
    );
});
