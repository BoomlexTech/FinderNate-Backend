import mongoose from 'mongoose';
import { User } from '../models/user.models.js';
import Block from '../models/block.models.js';
import { getFollowingIdSet } from './followEngagement.utils.js';
import { notifyActivity } from './activityNotify.utils.js';
import { MAX_MENTIONS, extractMentionUsernames, canBeMentioned } from './mentions.rules.js';

export { MAX_MENTIONS, extractMentionUsernames, canBeMentioned };

/**
 * Resolve the mentions in some text, plus any user ids a client sent
 * explicitly, to the ids that may actually be mentioned by authorId.
 */
export const resolveMentions = async ({ texts = [], explicitIds = [], authorId }) => {
    const usernames = extractMentionUsernames(...texts);
    const ids = (Array.isArray(explicitIds) ? explicitIds : [])
        .map((id) => (typeof id === 'object' && id?._id ? id._id : id))
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        .map(String);

    if (!usernames.length && !ids.length) return [];

    const candidates = await User.find({
        $or: [
            ...(usernames.length ? [{ username: { $in: usernames } }] : []),
            ...(ids.length ? [{ _id: { $in: ids } }] : []),
        ],
        isDeleted: { $ne: true },
        accountStatus: 'active',
    }).select('_id mentionPrivacy').limit(MAX_MENTIONS).lean();

    if (!candidates.length) return [];
    const candidateIds = candidates.map((c) => c._id);

    const blocks = await Block.find({
        $or: [
            { blockerId: authorId, blockedId: { $in: candidateIds } },
            { blockedId: authorId, blockerId: { $in: candidateIds } },
        ],
    }).select('blockerId blockedId').lean();
    const blockedSet = new Set(blocks.flatMap((b) => [String(b.blockerId), String(b.blockedId)]));
    blockedSet.delete(String(authorId));

    const allowed = [];
    for (const c of candidates) {
        let followsAuthor = false;
        if (c.mentionPrivacy === 'following') {
            followsAuthor = (await getFollowingIdSet(c._id)).has(String(authorId));
        }
        if (canBeMentioned({
            mentionPrivacy: c.mentionPrivacy,
            followsAuthor,
            blocked: blockedSet.has(String(c._id)),
            isSelf: String(c._id) === String(authorId),
        })) {
            allowed.push(c._id);
        }
    }
    return allowed;
};

/**
 * Notify newly mentioned accounts. `skip` holds ids that already get a
 * notification for the same action (e.g. the post owner, who is told about
 * the comment anyway).
 */
export const notifyMentions = async ({ mentionIds = [], previousIds = [], skip = [], authorId, postId, commentId = null }) => {
    const before = new Set([...previousIds, ...skip].map(String));
    const fresh = mentionIds.filter((id) => !before.has(String(id)));
    await Promise.allSettled(fresh.map((recipientId) => notifyActivity({
        recipientId,
        senderId: authorId,
        type: 'mention',
        message: commentId ? 'mentioned you in a comment' : 'mentioned you in a post',
        postId,
        commentId,
        push: { title: 'You were mentioned' },
    })));
    return fresh;
};
