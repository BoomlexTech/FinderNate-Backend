import Post from '../models/userPost.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { User } from '../models/user.models.js';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import { assertCanViewPostById, assertPostInteractionAllowed } from '../controllers/post/visibility.js';

/**
 * In-app sharing of a post or vibe into a chat (Phase 2 #24).
 *
 * The message stores a snapshot of the post, the same way story replies store
 * a storyReference, so the bubble still renders a title, price and thumbnail
 * after the post is edited or removed. Tapping the bubble opens the live post,
 * which applies the normal visibility checks again.
 */

const truncate = (text, max) =>
    typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : (text || '');

const VIBE_TYPES = new Set(['reel', 'video']);

/**
 * Builds the snapshot for `postId` as shared by `senderId`.
 * Throws 404/403 when the sender may not see the post, or when its author has
 * switched sharing off (#18).
 */
export const buildSharedPostSnapshot = async (postId, senderId) => {
    const gate = await assertCanViewPostById(postId, senderId);
    assertPostInteractionAllowed(gate, senderId, 'share');

    const post = await Post.findById(postId)
        .select('userId postType contentType caption description media customization.product.name customization.product.price customization.product.currency customization.service.name customization.service.price customization.service.currency customization.business.businessName')
        .lean();
    const author = await User.findById(post.userId).select('username fullName profileImageUrl').lean();

    const first = Array.isArray(post.media) && post.media.length ? post.media[0] : {};
    const isVideo = first.type === 'video';
    const item = post.customization?.product?.name ? post.customization.product
        : post.customization?.service?.name ? post.customization.service
            : null;
    const price = typeof item?.price === 'number' ? item.price : null;

    return {
        postId: post._id,
        authorId: post.userId,
        authorUsername: author?.username || '',
        authorFullName: author?.fullName || '',
        authorProfileImageUrl: author?.profileImageUrl || '',
        postType: post.postType,
        contentType: post.contentType,
        isVibe: VIBE_TYPES.has(post.postType),
        caption: truncate(post.caption || post.description || '', 200),
        mediaType: first.url ? (isVideo ? 'video' : 'image') : null,
        thumbnailUrl: first.thumbnailUrl || (!isVideo ? first.url : '') || '',
        title: item?.name || post.customization?.business?.businessName || '',
        price,
        currency: price !== null ? (item?.currency || 'INR') : null,
        capturedAt: new Date(),
    };
};

/** Text used for the chat list preview and push body when no comment was typed. */
export const sharedPostSummary = (snapshot) =>
    snapshot?.isVibe ? 'Shared a vibe' : 'Shared a post';

/**
 * Counts one share of `postId` by `userId`, using the same Redis counter (with
 * the same DB fallback) as POST /share/track. Never throws: a failed counter
 * must not fail the message that was already delivered.
 */
export const recordPostShare = async (postId, userId) => {
    try {
        let shareCount = null;
        try {
            const results = await redisClient
                .multi()
                .incr(RedisKeys.postShareCount(postId))
                .expire(RedisKeys.postShareCount(postId), RedisTTL.SHARE_COUNT)
                .exec();
            // ioredis answers [[err, value], ...] for a transaction.
            const [err, count] = results?.[0] || [];
            shareCount = err ? null : (count ?? null);
        } catch (_) { /* fall back to the DB counter below */ }

        if (shareCount == null) {
            await Post.updateOne({ _id: postId }, { $inc: { 'engagement.shares': 1 } });
        }
        await PostInteraction.create({
            userId,
            postId,
            interactionType: 'share',
            lastInteracted: new Date(),
        });
    } catch (err) {
        console.error('recordPostShare failed:', err?.message || err);
    }
};
