import Chat from '../models/chat.models.js';
import Message from '../models/message.models.js';
import { User } from '../models/user.models.js';
import socketManager from '../config/socket.js';
import { redisClient } from '../config/redis.config.js';
import { systemMessageText } from './chatRoles.rules.js';

/** Drops the cached chat lists of these users (the same keys getUserChats writes). */
export const invalidateChatLists = async (userIds = []) => {
    try {
        const dels = [];
        for (const id of userIds.map(String)) {
            for (let page = 1; page <= 3; page++) {
                dels.push(
                    redisClient.del(`chats:user:${id}:status:active:page:${page}:limit:20`),
                    redisClient.del(`chats:user:${id}:status:requested:page:${page}:limit:20`)
                );
            }
        }
        await Promise.all(dels);
    } catch (error) {
        console.error('Chat list cache invalidation failed:', error?.message || error);
    }
};

const emitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) socketManager.emitToChat(String(chatId), event, data);
};

/**
 * Writes a system message ("Asha made Ravi an admin") into the chat and tells
 * everyone in it. Counts as already read, so it never shows as unread.
 * Never throws: the action it describes has already happened.
 */
export const postSystemMessage = async (chatOrId, action, { actorId, targetIds = [], data = {} } = {}) => {
    try {
        const chat = chatOrId?._id ? chatOrId : await Chat.findById(chatOrId);
        if (!chat) return null;

        const ids = [actorId, ...targetIds].filter(Boolean).map(String);
        const users = ids.length
            ? await User.find({ _id: { $in: ids } }).select('username fullName').lean()
            : [];
        const byId = new Map(users.map((u) => [String(u._id), u]));
        const actor = byId.get(String(actorId)) || null;
        const targets = targetIds.map((id) => byId.get(String(id)) || null);
        const text = systemMessageText(action, actor, targets, data);

        const now = new Date();
        const msg = await Message.create({
            chatId: chat._id,
            sender: actorId || chat.createdBy,
            message: text,
            messageType: 'system',
            system: { action, actorId: actorId || null, targetIds, data },
            timestamp: now,
            readBy: chat.participants,
            deliveryStatus: [],
        });

        await Chat.updateOne(
            { _id: chat._id },
            {
                $set: {
                    lastMessageAt: now,
                    lastMessageId: msg._id,
                    lastMessage: { sender: actorId || chat.createdBy, message: text, timestamp: now },
                },
            }
        );

        const populated = await Message.findById(msg._id)
            .populate('sender', 'username fullName profileImageUrl')
            .lean();
        emitToChat(chat._id, 'new_message', { chatId: String(chat._id), message: populated });
        invalidateChatLists(chat.participants);
        return populated;
    } catch (error) {
        console.error('System message failed:', error?.message || error);
        return null;
    }
};
