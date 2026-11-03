import mongoose from 'mongoose';
import Chat from '../../models/chat.models.js';
import Message from '../../models/message.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { safeEmitToChat } from './helpers.js';
import { VIEW_ONCE_OPEN_GRACE_MS, notExpiredFilter } from '../../utils/chatRoles.rules.js';

/**
 * POST /chats/:chatId/messages/:messageId/view-once
 *
 * Opens a view-once photo or video (Phase 3 #48). Only the recipient, and only
 * once: the first call returns the media link (or, in an encrypted chat, the
 * encrypted envelope that holds it), records the open, and schedules the file
 * for deletion a few minutes later, long enough to finish loading. Every later
 * call answers 410.
 */
export const openViewOnceMessage = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { chatId, messageId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(chatId) || !mongoose.Types.ObjectId.isValid(messageId)) {
        throw new ApiError(400, 'Invalid id');
    }

    const chat = await Chat.findOne({ _id: chatId, participants: userId }).select('_id participants').lean();
    if (!chat) throw new ApiError(404, 'Chat not found or access denied');

    const now = new Date();
    // Atomic: two taps at once can't both get the link.
    const msg = await Message.findOneAndUpdate(
        {
            _id: messageId,
            chatId,
            viewOnce: true,
            viewOnceExpired: { $ne: true },
            deletedForEveryone: { $ne: true },
            sender: { $ne: userId },
            'viewOnceOpenedBy.userId': { $ne: userId },
            $and: [notExpiredFilter(now)],
        },
        {
            $push: { viewOnceOpenedBy: { userId, openedAt: now } },
            $set: { viewOnceMediaDeleteAt: new Date(now.getTime() + VIEW_ONCE_OPEN_GRACE_MS) },
        },
        { new: false }
    ).select('messageType mediaUrl e2ee sender duration').lean();

    if (!msg) {
        const exists = await Message.exists({ _id: messageId, chatId, viewOnce: true });
        if (!exists) throw new ApiError(404, 'Message not found');
        throw new ApiError(410, 'This view-once message has already been opened or has expired');
    }

    safeEmitToChat(chatId, 'view_once_opened', { chatId, messageId, openedBy: userId, openedAt: now });

    return res.status(200).json(new ApiResponse(200, {
        messageId,
        messageType: msg.messageType,
        mediaUrl: msg.messageType === 'encrypted' ? null : msg.mediaUrl,
        e2ee: msg.messageType === 'encrypted' ? msg.e2ee : undefined,
        duration: msg.duration,
        // The file is deleted after this; the app should not cache it.
        availableForSeconds: Math.round(VIEW_ONCE_OPEN_GRACE_MS / 1000),
    }, 'Opened'));
});
