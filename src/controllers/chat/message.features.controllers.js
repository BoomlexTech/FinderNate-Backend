import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { safeEmitToChat, getBlockedParticipantIds } from './helpers.js';
import { redactViewOnce, expiryFor, notExpiredFilter } from '../../utils/chatRoles.rules.js';
import { prepareEncryptedMessage } from '../../utils/e2ee.utils.js';

export const addReaction = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
        throw new ApiError(400, 'Emoji is required');
    }

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    const existingReactionIndex = message.reactions.findIndex(
        r => r.user.toString() === currentUserId.toString()
    );

    if (existingReactionIndex !== -1) {
        message.reactions[existingReactionIndex].emoji = emoji;
        message.reactions[existingReactionIndex].timestamp = new Date();
    } else {
        message.reactions.push({
            user: currentUserId,
            emoji,
            timestamp: new Date()
        });
    }

    await message.save();

    const populatedMessage = await Message.findById(messageId)
        .populate('sender', 'username fullName profileImageUrl')
        .populate('reactions.user', 'username fullName profileImageUrl')
        .lean();

    safeEmitToChat(chatId, 'message_reaction_added', {
        chatId,
        messageId,
        reaction: {
            user: {
                _id: currentUserId,
                username: req.user.username,
                fullName: req.user.fullName,
                profileImageUrl: req.user.profileImageUrl
            },
            emoji,
            timestamp: new Date()
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedMessage, 'Reaction added successfully')
    );
});

export const removeReaction = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOneAndUpdate(
        { _id: messageId, chatId },
        { $pull: { reactions: { user: currentUserId } } },
        { new: true }
    ).populate('sender', 'username fullName profileImageUrl')
     .populate('reactions.user', 'username fullName profileImageUrl');

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    safeEmitToChat(chatId, 'message_reaction_removed', {
        chatId,
        messageId,
        userId: currentUserId.toString()
    });

    return res.status(200).json(
        new ApiResponse(200, message, 'Reaction removed successfully')
    );
});

export const editMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { message: newContent } = req.body;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId,
        sender: currentUserId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found or you are not the sender');
    }

    if (['system', 'gif', 'sticker'].includes(message.messageType) || message.viewOnce) {
        throw new ApiError(400, "This message can't be edited");
    }

    // Encrypted message (Phase 3 #2): the edit is a new envelope.
    if (message.messageType === 'encrypted') {
        const age = Date.now() - new Date(message.timestamp).getTime();
        if (age > 24 * 60 * 60 * 1000) throw new ApiError(400, 'Cannot edit messages older than 24 hours');
        message.e2ee = await prepareEncryptedMessage(chat, currentUserId, req.body.e2ee);
        message.editedAt = new Date();
        message.isEdited = true;
        await message.save();
        safeEmitToChat(chatId, 'message_edited', {
            chatId,
            messageId,
            e2ee: message.e2ee,
            editedAt: message.editedAt,
            editedBy: { _id: currentUserId, username: req.user.username, fullName: req.user.fullName }
        });
        const populatedEncrypted = await Message.findById(messageId)
            .populate('sender', 'username fullName profileImageUrl')
            .lean();
        return res.status(200).json(new ApiResponse(200, populatedEncrypted, 'Message edited successfully'));
    }

    if (!newContent || newContent.trim().length === 0) {
        throw new ApiError(400, 'Message content is required');
    }

    const messageAge = Date.now() - new Date(message.timestamp).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (messageAge > twentyFourHours) {
        throw new ApiError(400, 'Cannot edit messages older than 24 hours');
    }

    if (!message.originalMessage) {
        message.originalMessage = message.message;
    }

    message.message = newContent.trim();
    message.editedAt = new Date();

    await message.save();

    const populatedMessage = await Message.findById(messageId)
        .populate('sender', 'username fullName profileImageUrl')
        .populate('reactions.user', 'username fullName profileImageUrl')
        .lean();

    if (chat.lastMessageId && chat.lastMessageId.toString() === messageId) {
        chat.lastMessage.message = newContent.trim();
        await chat.save();
    }

    safeEmitToChat(chatId, 'message_edited', {
        chatId,
        messageId,
        newContent: newContent.trim(),
        editedAt: message.editedAt,
        editedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, populatedMessage, 'Message edited successfully')
    );
});

export const forwardMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;
    const { targetChatIds } = req.body;

    if (!targetChatIds || !Array.isArray(targetChatIds) || targetChatIds.length === 0) {
        throw new ApiError(400, 'Target chat IDs are required');
    }

    const sourceChat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!sourceChat) {
        throw new ApiError(404, 'Source chat not found or access denied');
    }

    const originalMessage = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    }).populate('sender', 'username fullName');

    if (!originalMessage) {
        throw new ApiError(404, 'Message not found');
    }

    // Phase 3: view-once media can't be forwarded (#48), and the server can't
    // re-encrypt an encrypted message for someone else (#2) — the app decrypts
    // it and sends it as a new message instead. System notices aren't messages.
    if (originalMessage.viewOnce) {
        throw new ApiError(400, "View-once photos and videos can't be forwarded");
    }
    if (originalMessage.messageType === 'encrypted') {
        const err = new ApiError(400, 'Encrypted messages are forwarded from your device');
        err.data = { code: 'E2EE_FORWARD_ON_DEVICE' };
        throw err;
    }
    if (originalMessage.messageType === 'system') {
        throw new ApiError(400, "This message can't be forwarded");
    }

    const forwardedMessages = [];

    for (const targetChatId of targetChatIds) {
        const targetChat = await Chat.findOne({
            _id: targetChatId,
            participants: currentUserId
        });

        if (!targetChat) {
            continue;
        }

        // Forwarding is a second way to put a message in front of someone —
        // addMessage refuses a blocked direct chat, and this must too, or the
        // block is one share sheet away from being bypassed. Skipped rather
        // than thrown so forwarding to five chats does not fail wholesale
        // because one of them is blocked.
        if (targetChat.chatType === 'direct') {
            const blocked = await getBlockedParticipantIds(currentUserId, targetChat.participants);
            if (blocked.size > 0) {
                continue;
            }
        }

        const recipients = targetChat.participants.filter(
            p => p.toString() !== currentUserId.toString()
        );

        const forwardedMessage = await Message.create({
            chatId: targetChatId,
            sender: currentUserId,
            message: originalMessage.message,
            messageType: originalMessage.messageType,
            mediaUrl: originalMessage.mediaUrl,
            fileName: originalMessage.fileName,
            fileSize: originalMessage.fileSize,
            duration: originalMessage.duration,
            // A shared post keeps its snapshot so the forwarded bubble still
            // renders (#24); the post itself is re-checked when it is opened.
            ...(originalMessage.messageType === 'shared_post' && originalMessage.sharedPost
                ? { sharedPost: originalMessage.sharedPost }
                : {}),
            ...(['gif', 'sticker'].includes(originalMessage.messageType) && originalMessage.gif
                ? { gif: originalMessage.gif }
                : {}),
            // The target chat's disappearing timer applies (#37).
            expiresAt: expiryFor(targetChat, originalMessage.messageType),
            timestamp: new Date(),
            readBy: [currentUserId],
            deliveryStatus: recipients.map(recipientId => ({
                userId: recipientId,
                status: 'sent',
                deliveredAt: null,
                seenAt: null
            })),
            forwardedFrom: {
                messageId: originalMessage._id,
                chatId: chatId,
                originalSender: originalMessage.sender._id
            }
        });

        targetChat.lastMessageAt = new Date();
        targetChat.lastMessage = {
            sender: currentUserId,
            message: originalMessage.message,
            timestamp: new Date()
        };
        targetChat.lastMessageId = forwardedMessage._id;
        await targetChat.save();

        const populatedMessage = await Message.findById(forwardedMessage._id)
            .populate('sender', 'username fullName profileImageUrl')
            .lean();

        forwardedMessages.push(populatedMessage);

        safeEmitToChat(targetChatId, 'new_message', {
            chatId: targetChatId,
            message: {
                ...populatedMessage,
                isForwarded: true
            }
        });
    }

    return res.status(201).json(
        new ApiResponse(201, {
            forwardedCount: forwardedMessages.length,
            messages: forwardedMessages
        }, 'Message forwarded successfully')
    );
});

export const togglePinMessage = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId, messageId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    const message = await Message.findOne({
        _id: messageId,
        chatId,
        deletedForEveryone: { $ne: true }
    });

    if (!message) {
        throw new ApiError(404, 'Message not found');
    }

    if (!chat.pinnedMessages) {
        chat.pinnedMessages = [];
    }

    const isPinned = chat.pinnedMessages.some(id => id.toString() === messageId);

    if (isPinned) {
        chat.pinnedMessages = chat.pinnedMessages.filter(id => id.toString() !== messageId);
    } else {
        if (chat.pinnedMessages.length >= 3) {
            throw new ApiError(400, 'Maximum 3 messages can be pinned. Unpin a message first.');
        }
        chat.pinnedMessages.push(messageId);
    }

    await chat.save();

    safeEmitToChat(chatId, 'message_pin_toggled', {
        chatId,
        messageId,
        isPinned: !isPinned,
        pinnedBy: {
            _id: currentUserId,
            username: req.user.username,
            fullName: req.user.fullName
        }
    });

    return res.status(200).json(
        new ApiResponse(200, {
            messageId,
            isPinned: !isPinned,
            pinnedMessages: chat.pinnedMessages
        }, isPinned ? 'Message unpinned successfully' : 'Message pinned successfully')
    );
});

export const getPinnedMessages = asyncHandler(async (req, res) => {
    const currentUserId = req.user._id;
    const { chatId } = req.params;

    const chat = await Chat.findOne({
        _id: chatId,
        participants: currentUserId
    });

    if (!chat) {
        throw new ApiError(404, 'Chat not found or access denied');
    }

    if (!chat.pinnedMessages || chat.pinnedMessages.length === 0) {
        return res.status(200).json(
            new ApiResponse(200, { messages: [] }, 'No pinned messages')
        );
    }

    const pinnedMessages = await Message.find({
        _id: { $in: chat.pinnedMessages },
        deletedForEveryone: { $ne: true },
        $and: [notExpiredFilter()]
    })
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    return res.status(200).json(
        new ApiResponse(200, {
            messages: pinnedMessages.map(m => (m.viewOnce ? redactViewOnce(m, currentUserId) : m))
        }, 'Pinned messages fetched successfully')
    );
});
