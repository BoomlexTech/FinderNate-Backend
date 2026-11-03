import mongoose from 'mongoose';
import { User } from '../models/user.models.js';
import Block from '../models/block.models.js';
import { getFollowingIdSet } from './followEngagement.utils.js';
import { notifyActivity } from './activityNotify.utils.js';

/**
 * @mentions in posts and comments (Phase 2 #64).
 *
 * The text keeps whatever the author typed; what the server decides is who
 * becomes a real mention (stored, linkable, notified). An account is
 * mentionable unless it is gone, it and the author have blocked each other,
 * or its mentionPrivacy says no:
 *   everyone  - anyone
 *   following - only accounts it follows
 *   nobody    - no one
 */

export const MAX_MENTIONS = 20;

// "@" at the start or after a character that can't be part of a username or
// an email address, then a username: letters, digits, "_" and ".".
const MENTION_RE = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g;

/** Lower-cased, de-duplicated usernames @mentioned in the given texts, in order. */
export const extractMentionUsernames = (...texts) => {
    const seen = new Set();
    for (const text of texts) {
        if (typeof text !== 'string' || !text.includes('@')) continue;
        MENTION_RE.lastIndex = 0;
        let m;
        while ((m = MENTION_RE.exec(text))) {
            seen.add(m[2].toLowerCase());
            if (seen.size >= MAX_MENTIONS) return [...seen];
        }
    }
    return [...seen];
};

/**
 * Pure rule for one candidate. `followsAuthor` is whether the candidate
 * follows the author; it only matters for 'following'.
 */
export const canBeMentioned = ({ mentionPrivacy = 'everyone', followsAuthor = false, blocked = false, isSelf = false }) => {
    if (isSelf || blocked) return false;
    if (mentionPrivacy === 'nobody') return false;
    if (mentionPrivacy === 'following') return followsAuthor === true;
    return true;
};

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
