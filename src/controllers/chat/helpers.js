import socketManager from '../../config/socket.js';
import Follower from '../../models/follower.models.js';
import Block from '../../models/block.models.js';
import { ApiError } from '../../utils/ApiError.js';

export const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for chat ${chatId}`);
    }
};

export const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    } else {
        console.warn(`Socket not ready, skipping ${event} for user ${userId}`);
    }
};

export const checkFollowStatus = async (followerId, userId) => {
    const followRelation = await Follower.findOne({ followerId, userId });
    return !!followRelation;
};

/**
 * Which of `otherUserIds` have a block with `userId`, in either direction.
 *
 * One query for the whole set rather than one per participant, so a group
 * chat costs the same as a direct one. Returns a Set of id STRINGS.
 */
export const getBlockedParticipantIds = async (userId, otherUserIds = []) => {
    const others = otherUserIds
        .map(id => id?.toString())
        .filter(id => id && id !== userId?.toString());

    if (!userId || others.length === 0) {
        return new Set();
    }

    const blocks = await Block.find({
        $or: [
            { blockerId: userId, blockedId: { $in: others } },
            { blockerId: { $in: others }, blockedId: userId }
        ]
    }).select('blockerId blockedId').lean();

    const userIdStr = userId.toString();
    return new Set(
        blocks.map(block =>
            block.blockerId.toString() === userIdStr
                ? block.blockedId.toString()
                : block.blockerId.toString()
        )
    );
};

/**
 * Blocking is enforced HERE, on the server, for every path that reads or
 * writes a conversation.
 *
 * Nothing in the chat controllers looked at Block at all: the clients hid the
 * message box, and that was the whole of the protection — so a blocked user
 * who kept a chat screen open, replayed a request, or used the API directly
 * could still send and still read. A block has to survive the client not
 * cooperating, which is the entire point of blocking someone.
 *
 * Throws 403 naming the situation; the caller sees a message it can show.
 */
export const assertNotBlockedInChat = async (userId, participants = [], action = 'message') => {
    const blocked = await getBlockedParticipantIds(userId, participants);

    if (blocked.size > 0) {
        throw new ApiError(
            403,
            action === 'read'
                ? 'This conversation is unavailable because of blocking.'
                : 'You cannot send messages in this conversation because of blocking.'
        );
    }
};

// Chat mute rules (#38) live in a dependency-free module so they can be unit tested.
export { MUTE_DURATIONS, muteStateFor, isChatMutedFor, muteFieldsFor } from '../../utils/chatMute.utils.js';
