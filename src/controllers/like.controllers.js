import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Like from "../models/like.models.js";
import Post from "../models/userPost.models.js";
import Comment from "../models/comment.models.js";
import { createLikeNotification, createUnlikeNotification } from "./notification.controllers.js";
import { redisClient, RedisKeys, RedisTTL } from "../config/redis.config.js";
import { onPostLiked, onPostUnliked, batchIsLikedByUser } from "../utils/postEngagement.utils.js";
import { likeQueue } from "../queues/likeQueue.js";
import socketManager from "../config/socket.js";
import { assertCanViewPostById, assertPostInteractionAllowed } from "./post/visibility.js";

const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;

/**
 * Ensure fn:post:{postId}:likes:count exists in Redis.
 * If missing (new post or key expired), seeds it from DB and applies the delta.
 * Returns the up-to-date count.
 */
async function ensureLikesCount(postId, delta) {
    const countKey = RedisKeys.postLikesCount(postId.toString());
    let count = await redisClient.get(countKey);
    if (count === null) {
        // Key missing — seed from DB then apply delta
        const doc = await Post.findById(postId).select('engagement.likes').lean();
        const base = doc?.engagement?.likes ?? 0;
        count = Math.max(0, base + delta);
        await redisClient.set(countKey, count, 'EX', ENGAGEMENT_TTL);
    } else {
        count = parseInt(count, 10);
    }
    return count;
}

/**
 * Check whether a user has liked a specific post.
 * Delegates to batchIsLikedByUser which seeds the full user liked Set from DB
 * on a cache miss, ensuring the check is always authoritative (no stale misses
 * when the Set has expired but the Like document hasn't been written to DB yet).
 */
async function getLikeStatus(userId, postId) {
    try {
        const likedSet = await batchIsLikedByUser(userId, [postId]);
        return likedSet.has(postId.toString());
    } catch {
        return !!(await Like.exists({ userId, postId }));
    }
}

const User = Post.db.model('User');
const USER_FIELDS = 'username profileImageUrl fullName isVerified';

/**
 * Fetch the likedBy user list with pagination.
 *
 * Page 1: reads the likedBy Redis Hash (fn:post:{postId}:likedby).
 *   field = userId, value = JSON{_id, userId, username, fullName, profileImageUrl, likedAt}.
 *   Entries sorted newest-first (likedAt desc), up to `limit`.
 *   Falls back to DB on cache miss.
 * Page 2+: always reads from DB.
 *
 * Lag compensation:
 *   - includeUser:   viewer just liked; Lua already HSET them into the Hash.
 *     We unshift at position 0 to guarantee they appear first.
 *   - excludeUserId: viewer just unliked; Lua already HDELd them from the Hash.
 */
async function getLikedByList(postId, { includeUser = null, includeUserId = null, excludeUserId = null, page = 1, limit = 20 } = {}) {
    const postIdStr = postId.toString();
    const includeId = includeUser?._id?.toString() ?? (includeUserId ? includeUserId.toString() : null);

    // Page 1: read from the Redis Hash; fall through to DB if empty or Redis is down
    if (page === 1) {
        try {
            const hashData = await redisClient.hgetall(RedisKeys.postLikedBy(postIdStr));
            // ioredis v5 returns {} (not null) for missing keys
            const entries = hashData && Object.keys(hashData).length > 0 ? Object.values(hashData) : null;

            if (entries && entries.length > 0) {
                let users = entries
                    .map(v => { try { return JSON.parse(v); } catch { return null; } })
                    .filter(Boolean);

                const excludeStr = excludeUserId?.toString();
                if (excludeStr) users = users.filter(u => (u._id || u.userId) !== excludeStr);
                if (includeId) users = users.filter(u => (u._id || u.userId) !== includeId);

                // Sort newest-first by likedAt
                users.sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
                const hasMore = users.length > limit;
                let pageUsers = users.slice(0, limit);

                if (includeId) {
                    let me;
                    if (includeUser) {
                        me = {
                            _id: includeUser._id,
                            username: includeUser.username,
                            fullName: includeUser.fullName,
                            profileImageUrl: includeUser.profileImageUrl,
                            isVerified: includeUser.isVerified,
                        };
                    } else {
                        me = await User.findById(includeUserId, USER_FIELDS).lean();
                    }
                    if (me) pageUsers.unshift(me);
                }

                return { users: pageUsers, hasMore };
            }
            // hashData null (key missing) or empty hash → fall through to DB
        } catch (_) {
            // Redis down or parse error → fall through to DB
        }
    }

    // DB path: cache miss or page > 1
    const skip = (page - 1) * limit;
    const likes = await Like.find({ postId })
        .select('userId')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1)
        .lean();

    let userIds = likes.map(l => l.userId.toString());
    const hasMore = userIds.length > limit;
    if (hasMore) userIds = userIds.slice(0, limit);

    if (excludeUserId) userIds = userIds.filter(id => id !== excludeUserId.toString());
    if (page === 1 && includeId) userIds = userIds.filter(id => id !== includeId);

    const users = userIds.length
        ? await User.find({ _id: { $in: userIds } }, USER_FIELDS).lean()
        : [];

    if (page === 1 && includeId) {
        let me;
        if (includeUser) {
            me = {
                _id: includeUser._id,
                username: includeUser.username,
                fullName: includeUser.fullName,
                profileImageUrl: includeUser.profileImageUrl,
                isVerified: includeUser.isVerified,
            };
        } else {
            me = await User.findById(includeUserId, USER_FIELDS).lean();
        }
        if (me) users.unshift(me);
    }

    return { users, hasMore };
}

// Like a post — writes to Redis only; DB synced by nightly cron at 22:00
export const likePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    // Liking is only allowed on a post the caller is allowed to SEE. This used
    // to check nothing beyond "postId is truthy" — not even that the post
    // existed — so an account the author had blocked could alternate like and
    // unlike to push a notification into the blocker's tray on every call, and
    // like counters could be moved on posts the actor may not view.
    const targetPost = await assertCanViewPostById(postId, userId);
    // The author can switch likes off per post (#18). Unliking stays allowed
    // so an existing like can always be taken back.
    assertPostInteractionAllowed(targetPost, userId, 'like');

    // Idempotent. Liking something already liked is not an error — it is a
    // client whose optimistic state drifted from the server's, which happens
    // routinely: the feed and Vibes render the same post from separate caches,
    // a tap can be sent twice, a stale feed page can be scrolled back to.
    //
    // This used to answer 409, and the app surfaced that as "Error liking
    // Post" and reverted the heart — so the user saw a failure for a post that
    // was, in fact, already in exactly the state they wanted. Return the
    // current truth instead and let the client settle on it.
    const alreadyLiked = await getLikeStatus(userId, postId);
    if (alreadyLiked) {
        const { users: likedBy, hasMore } = await getLikedByList(postId, { includeUser: req.user });
        return res.status(200).json(new ApiResponse(200, {
            likedBy,
            hasMore,
            isLikedBy: true,
            likesCount: await ensureLikesCount(postId, 0),
        }, "Post already liked"));
    }

    const result = await onPostLiked(userId, postId, {
        username: req.user.username,
        fullName: req.user.fullName,
        profileImageUrl: req.user.profileImageUrl,
    });

    // Enqueue DB sync job (BullMQ handles retry + batch write)
    likeQueue.add('like-event', {
        userId: userId.toString(),
        postId: postId.toString(),
        action: 'like',
    }).catch(() => {});

    // Fire-and-forget notification (does not block response)
    if (targetPost.userId.toString() !== userId.toString()) {
        createLikeNotification({ recipientId: targetPost.userId, sourceUserId: userId, postId }).catch(() => {});
    }

    const [{ users: likedBy, hasMore }] = await Promise.all([
        getLikedByList(postId, { includeUser: result.ok ? req.user : null }),
    ]);

    // Lua returns the new count; fall back to DB-seed only if Lua failed entirely
    const likesCount = result.count ?? await ensureLikesCount(postId, +1);
    socketManager.emitGlobal('post_engagement_updated', { postId: postId.toString(), likesCount });

    return res.status(200).json(new ApiResponse(200, {
        likedBy,
        hasMore,
        isLikedBy: true,
        likesCount,
    }, "Post liked successfully"));
});

// Unlike a post — writes to Redis only; DB synced by nightly cron at 22:00
export const unlikePost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body;
    if (!postId) throw new ApiError(400, "postId is required");

    // Same gate as likePost: the unlike half of the like/unlike loop delivered
    // its own notification, so leaving it unchecked would leave the abuse path
    // open.
    const targetPost = await assertCanViewPostById(postId, userId);

    // Idempotent, for the same reason as likePost above. This answered 404
    // "You have not liked this post", which the app showed as an error and
    // then reverted — so unliking, liking, and unliking again could fail
    // purely because two views of the same post disagreed about its state.
    const isLiked = await getLikeStatus(userId, postId);
    if (!isLiked) {
        const { users: likedBy, hasMore } = await getLikedByList(postId, { excludeUserId: userId });
        return res.status(200).json(new ApiResponse(200, {
            likedBy,
            hasMore,
            isLikedBy: false,
            likesCount: await ensureLikesCount(postId, 0),
        }, "Post already not liked"));
    }

    const result = await onPostUnliked(userId, postId);

    // Enqueue DB sync job
    likeQueue.add('like-event', {
        userId: userId.toString(),
        postId: postId.toString(),
        action: 'unlike',
    }).catch(() => {});

    // Fire-and-forget notification
    if (targetPost.userId.toString() !== userId.toString()) {
        createUnlikeNotification({ recipientId: targetPost.userId, sourceUserId: userId, postId }).catch(() => {});
    }

    const [{ users: likedBy, hasMore }] = await Promise.all([
        getLikedByList(postId, { excludeUserId: result.ok ? userId : null }),
    ]);

    const likesCount = result.count ?? await ensureLikesCount(postId, -1);
    socketManager.emitGlobal('post_engagement_updated', { postId: postId.toString(), likesCount });

    return res.status(200).json(new ApiResponse(200, {
        likedBy,
        hasMore,
        isLikedBy: false,
        likesCount,
    }, "Post unliked successfully"));
});

/**
 * GET /post/liked-by?postId=&page=&limit=
 *
 * Paginated list of users who liked a post, fetched from DB.
 * The current user is excluded from the result set so the client can prepend
 * them at position 0 when isLikedByCurrentUser is true — avoids duplication
 * if their like has already been synced to DB.
 *
 * Auth: optional — unauthenticated callers receive the list for any post they
 * would be allowed to open.
 */
export const getLikedByUsers = asyncHandler(async (req, res) => {
    const { postId, page = '1', limit = '20' } = req.query;
    if (!postId) throw new ApiError(400, "postId is required");

    // Who liked a post is the post's data: it used to be enumerable for any
    // postId, by anyone, including private posts and blocked-from authors.
    await assertCanViewPostById(postId, req.user?._id || null);

    const currentUserId = req.user?._id?.toString();
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    // Page 1 reads from Redis hash (includes unsynced likes); page 2+ falls back to DB
    const { users, hasMore } = await getLikedByList(postId, {
        excludeUserId: currentUserId || null,
        page: parsedPage,
        limit: parsedLimit,
    });

    return res.status(200).json(new ApiResponse(200, { users, hasMore, page: parsedPage }, "Liked by users fetched successfully"));
});

// Like a comment
export const likeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    // The comment's POST decides who may see this thread. Without this gate the
    // route was a hole straight through every other check on the post: a blocked
    // account — one that 404s on the post itself and on getCommentsByPost — could
    // still like a comment on it, and the 200 response returns `likedBy` with the
    // username, full name and avatar of everyone in that private thread. It also
    // wrote a Like row on unreadable content and fired a notification (socket +
    // FCM push) at the person who had blocked them, repeatably via like/unlike.
    // Same guard the sibling handlers in this file already use.
    const target = await Comment.findById(commentId).select("postId");
    if (!target) throw new ApiError(404, "Comment not found");
    await assertCanViewPostById(target.postId, userId);

    try {
        await Like.create({ userId, commentId });
        // Notify comment owner (if not self)
        const comment = await Comment.findById(commentId).select("userId postId");
        if (comment && comment.userId.toString() !== userId.toString()) {
            await createLikeNotification({ recipientId: comment.userId, sourceUserId: userId, commentId, postId: comment.postId });
        }
        // Return updated likedBy and isLikedBy
        const likes = await Like.find({ commentId }).lean();
        const userIds = likes.map(like => like.userId.toString());
        let users = [];
        if (userIds.length > 0) {
            users = await Post.db.model('User').find(
                { _id: { $in: userIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
        }
        const isLikedBy = userIds.includes(userId.toString());
        return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy }, "Comment liked successfully"));
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "You have already liked this comment");
        }
        throw err;
    }
});

// Unlike a comment
export const unlikeComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.body;
    if (!commentId) throw new ApiError(400, "commentId is required");

    // Gated for the same reason as likeComment above: the response returns the
    // thread's `likedBy` list, and the notification path is reachable from here
    // too, so leaving unlike open would leave the whole like/unlike loop open.
    const target = await Comment.findById(commentId).select("postId");
    if (!target) throw new ApiError(404, "Comment not found");
    await assertCanViewPostById(target.postId, userId);

    const like = await Like.findOneAndDelete({ userId, commentId });
    if (like) {
        // Notify comment owner (if not self)
        const comment = await Comment.findById(commentId).select("userId postId");
        if (comment && comment.userId.toString() !== userId.toString()) {
            await createUnlikeNotification({ recipientId: comment.userId, sourceUserId: userId, commentId, postId: comment.postId });
        }
        // Return updated likedBy and isLikedBy
        const likes = await Like.find({ commentId }).lean();
        const userIds = likes.map(like => like.userId.toString());
        let users = [];
        if (userIds.length > 0) {
            users = await Post.db.model('User').find(
                { _id: { $in: userIds } },
                'username profileImageUrl fullName isVerified'
            ).lean();
        }
        const isLikedBy = userIds.includes(userId.toString());
        return res.status(200).json(new ApiResponse(200, { likedBy: users, isLikedBy }, "Comment unliked successfully"));
    } else {
        throw new ApiError(404, "Like not found for this comment");
    }
}); 