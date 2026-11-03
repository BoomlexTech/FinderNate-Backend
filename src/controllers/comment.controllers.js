import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Comment from "../models/comment.models.js";
import Post from "../models/userPost.models.js";
import Like from "../models/like.models.js";
import { createCommentNotification } from "./notification.controllers.js";
import { addBadgesToNestedUsers } from "../utils/userBadge.utils.js";
import { redisClient, RedisKeys, RedisTTL } from "../config/redis.config.js";
import socketManager from "../config/socket.js";
import { assertCanViewPostById, assertPostInteractionAllowed } from "./post/visibility.js";
import { resolveMentions, notifyMentions } from "../utils/mentions.utils.js";
import { invalidatePostCaches } from "./post/helpers.js";

const ENGAGEMENT_TTL = RedisTTL.POST_ENGAGEMENT;

/**
 * A comment id that is not an ObjectId is a comment that does not exist.
 *
 * Every handler here used to hand req.params.commentId straight to findById, so
 * "/comments/undefined" — which the clients do send when a thread id is missing
 * — raised a CastError deep inside Mongoose instead of the plain 404 the caller
 * can act on. Mirrors assertCanViewPostById in post/visibility.js, which does
 * the same for postIds, and answers 404 for the same reason: whether an id is
 * well-formed is not information worth a distinct status.
 */
const assertValidCommentId = (commentId, message = "Comment not found") => {
    if (!commentId || !mongoose.Types.ObjectId.isValid(commentId)) {
        throw new ApiError(404, message);
    }
};

/**
 * Keep post.engagement.comments and its Redis cache in step.
 *
 * Nothing used to maintain this counter: it was written as 0 when the post was
 * created and never touched again, so every post reported 0 comments no matter
 * how many existed. The website appeared to work only because it falls back to
 * a localStorage cache it populates when the comments drawer is opened; the
 * mobile app has no such cache and correctly displayed the 0 the API sent.
 *
 * REPLIES COUNT. A reply is an ordinary Comment document with parentCommentId
 * set and it flows through createComment like any other, so a top-level comment
 * with three replies totals four. This matches batchGetCommentsCount(), which
 * counts every non-deleted comment for the post with no parent filter.
 *
 * Mirrors ensureLikesCount() in like.controllers.js. Best-effort on the cache:
 * a Redis hiccup must never fail the user's comment, and the key carries a TTL
 * so it self-heals from the database on the next read.
 */
async function adjustCommentsCount(postId, delta) {
    try {
        const updated = await Post.findByIdAndUpdate(
            postId,
            { $inc: { "engagement.comments": delta } },
            { new: true, projection: { "engagement.comments": 1 } }
        ).lean();

        let count = updated?.engagement?.comments ?? 0;
        // Historical data was never incremented, so a decrement can drive this
        // negative. Clamp in the database rather than just in the response.
        if (count < 0) {
            await Post.findByIdAndUpdate(postId, {
                $set: { "engagement.comments": 0 },
            });
            count = 0;
        }

        await redisClient.set(
            RedisKeys.postCommentsCount(postId.toString()),
            count,
            "EX",
            ENGAGEMENT_TTL
        );
        return count;
    } catch (err) {
        console.error("[Comments] failed to adjust comment count:", err?.message || err);
        return null;
    }
}

// Create a new comment (or reply)
export const createComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId, content, parentCommentId, replyToUserId } = req.body;
    if (!postId || !content) throw new ApiError(400, "postId and content are required");

    // The post has to exist and the writer has to be allowed to see it.
    //
    // Nothing used to be checked here at all: Comment.create ran before the post
    // was ever looked up, and the only Post read that followed was for picking a
    // notification recipient, whose null result was ignored. So a blocked
    // account could still write into the blocker's thread, and anyone could
    // comment on a private account's post — the block/privacy boundary that
    // getPostById defends was bypassed by commenting instead of reading.
    // The post is fetched here anyway, so the notification below reuses it.
    const targetPost = await assertCanViewPostById(postId, userId);
    // The author can switch comments off per post (#18); replies count too.
    assertPostInteractionAllowed(targetPost, userId, 'comment');

    // If replying to a comment, fetch parent info and set up thread structure
    let finalReplyToUserId = replyToUserId || null;
    let rootCommentId = null;

    if (parentCommentId) {
        assertValidCommentId(parentCommentId, "Parent comment not found");

        const parentComment = await Comment.findById(parentCommentId).select("userId rootCommentId");
        if (!parentComment) {
            throw new ApiError(404, "Parent comment not found");
        }

        // Set replyToUserId if not provided
        if (!replyToUserId) {
            finalReplyToUserId = parentComment.userId;
        }

        // For thread tracking: if parent has a root, use that; otherwise parent IS the root
        rootCommentId = parentComment.rootCommentId || parentCommentId;
    }

    // @mentions (#64): only accounts that allow it become real mentions.
    const mentionIds = await resolveMentions({ texts: [content], authorId: userId });

    const comment = await Comment.create({
        postId,
        userId,
        content,
        parentCommentId: parentCommentId || null,
        rootCommentId,
        replyToUserId: finalReplyToUserId,
        ...(mentionIds.length ? { mentions: mentionIds } : {})
    });

    // Replies run through this same handler, so they are counted too.
    const commentsCount = await adjustCommentsCount(postId, 1);
    if (commentsCount !== null) socketManager.emitGlobal('post_engagement_updated', { postId: postId.toString(), commentsCount });

    // Send notification to post owner (if not commenting on own post)
    try {
        const post = targetPost;
        if (post && post.userId.toString() !== userId.toString()) {
            await createCommentNotification({
                recipientId: post.userId,
                sourceUserId: userId,
                postId,
                commentId: comment._id
            });
        }

        // If this is a reply to another comment, also notify the comment owner
        if (parentCommentId) {
            const parentComment = await Comment.findById(parentCommentId).select("userId");
            if (parentComment && parentComment.userId.toString() !== userId.toString()) {
                await createCommentNotification({
                    recipientId: parentComment.userId,
                    sourceUserId: userId,
                    postId,
                    commentId: comment._id,
                    isReply: true
                });
            }
        }
        // The post owner and the person replied to already hear about this
        // comment, so a mention of them is not announced twice.
        const alreadyNotified = [targetPost?.userId, finalReplyToUserId].filter(Boolean);
        await notifyMentions({ mentionIds, skip: alreadyNotified, authorId: userId, postId, commentId: comment._id });
    } catch (error) {
        // Log error but don't fail the comment creation
        console.error("Error sending comment notification:", error);
    }

    // Populate user and replyToUser before returning
    const populatedComment = await Comment.findById(comment._id)
        .populate('userId', 'username fullName profileImageUrl isBusinessProfile')
        .populate('replyToUserId', 'username fullName profileImageUrl isBusinessProfile')
        .populate('mentions', 'username')
        .lean();

    // Add badges to user and replyToUser
    const [commentWithBadges] = await addBadgesToNestedUsers([populatedComment]);

    return res.status(201).json(new ApiResponse(201, commentWithBadges, "Comment created successfully"));
});

// Get all comments for a post
export const getCommentsByPost = asyncHandler(async (req, res) => {
    const { postId, page = 1, limit = 20 } = req.query;
    if (!postId) throw new ApiError(400, "postId is required");

    // ✅ FIXED: Handle both Mongoose document and plain object from cache
    const userId = req.user?._id ? req.user._id.toString() : null;
    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (pageNum - 1) * pageLimit;

    // Reading a thread is reading the post. This endpoint used to load no post
    // at all — not even to check it existed — so a signed-out caller holding a
    // postId got every comment on a private account's post, and a blocked user
    // got the thread the post itself answers 404 for.
    const post = await assertCanViewPostById(postId, req.user?._id || null);

    // The creator's pinned comment (#53) leads page 1 and is left out of the
    // pages themselves, so it is never shown twice.
    const pinnedId = post?.pinnedCommentId || null;
    const listFilter = { postId, parentCommentId: null, isDeleted: false, ...(pinnedId ? { _id: { $ne: pinnedId } } : {}) };

    // ✅ OPTIMIZED: Only fetch top-level comments (parentCommentId: null)
    const [comments, total, pinnedRows] = await Promise.all([
        Comment.find(listFilter)
            .populate({
                path: 'userId',
                select: 'username fullName profileImageUrl isBusinessProfile',
                match: { accountStatus: 'active', isDeleted: { $ne: true } }
            })
            .populate('replyToUserId', 'username fullName profileImageUrl isBusinessProfile')
            .populate('mentions', 'username')
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(pageLimit)
            .lean(),
        Comment.countDocuments(listFilter),
        pinnedId && pageNum === 1
            ? Comment.find({ _id: pinnedId, postId, parentCommentId: null, isDeleted: false })
                .populate({
                    path: 'userId',
                    select: 'username fullName profileImageUrl isBusinessProfile',
                    match: { accountStatus: 'active', isDeleted: { $ne: true } }
                })
                .populate('replyToUserId', 'username fullName profileImageUrl isBusinessProfile')
                .populate('mentions', 'username')
                .lean()
            : Promise.resolve([])
    ]);

    // Filter out comments from banned/deleted users (populate returns null userId when match fails)
    const pinnedVisible = pinnedRows.filter(c => c.userId != null).map(c => ({ ...c, isPinned: true }));
    const visibleComments = [...pinnedVisible, ...comments.filter(c => c.userId != null)];

    // Populate likes from Like collection for each comment
    const commentIds = visibleComments.map(c => c._id);
    const [likes, replyCounts] = await Promise.all([
        Like.find({ commentId: { $in: commentIds } })
            .populate('userId', 'username profileImageUrl fullName')
            .lean(),
        // ✅ Get TOTAL reply counts for each thread (handle both new and old data)
        Comment.aggregate([
            {
                $match: {
                    $or: [
                        { rootCommentId: { $in: commentIds } },  // New threading
                        {
                            parentCommentId: { $in: commentIds },
                            $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]  // Old data
                        }
                    ],
                    isDeleted: false
                }
            },
            {
                $group: {
                    // Group by rootCommentId if exists, otherwise by parentCommentId (for old data)
                    _id: { $ifNull: ['$rootCommentId', '$parentCommentId'] },
                    count: { $sum: 1 }
                }
            }
        ])
    ]);

    // Group likes by commentId
    const likesByComment = {};
    likes.forEach(like => {
        const commentId = like.commentId.toString();
        if (!likesByComment[commentId]) {
            likesByComment[commentId] = [];
        }
        likesByComment[commentId].push(like.userId);
    });

    // Group reply counts by commentId
    const replyCountMap = {};
    replyCounts.forEach(item => {
        replyCountMap[item._id.toString()] = item.count;
    });

    // Add likes and isLikedBy to each comment
    const enrichedComments = visibleComments.map(comment => {
        const commentLikes = likesByComment[comment._id.toString()] || [];
        const isLikedBy = userId ? commentLikes.some(u => u._id.toString() === userId) : false;

        return {
            ...comment,
            likes: commentLikes,
            isLikedBy,
            likesCount: commentLikes.length,
            replyCount: replyCountMap[comment._id.toString()] || 0
        };
    });

    // Add badges to all comments
    const commentsWithBadges = await addBadgesToNestedUsers(enrichedComments);

    return res.status(200).json(
        new ApiResponse(200, {
            totalComments: total + (pinnedId ? 1 : 0),
            page: pageNum,
            totalPages: Math.ceil(total / pageLimit),
            pinnedCommentId: pinnedId,
            comments: commentsWithBadges
        }, "Comments fetched successfully")
    );
});

// Helper function to recursively fetch all descendant comment IDs
async function getAllDescendantIds(commentIds) {
    if (!commentIds || commentIds.length === 0) return [];

    const directChildren = await Comment.find({
        parentCommentId: { $in: commentIds },
        isDeleted: false
    }).select('_id').lean();

    if (directChildren.length === 0) return [];

    const childIds = directChildren.map(c => c._id);
    const grandChildIds = await getAllDescendantIds(childIds);

    return [...childIds, ...grandChildIds];
}

// Get a single comment by ID
export const getCommentById = asyncHandler(async (req, res) => {
    const { commentId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    assertValidCommentId(commentId);

    // ✅ FIXED: Handle both Mongoose document and plain object from cache
    const userId = req.user?._id ? req.user._id.toString() : null;
    const pageNum = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 10;
    const skip = (pageNum - 1) * pageLimit;

    const comment = await Comment.findById(commentId)
        .populate('userId', 'username fullName profileImageUrl')
        .populate('replyToUserId', 'username fullName profileImageUrl')
        .lean();
    if (!comment || comment.isDeleted) throw new ApiError(404, "Comment not found");

    // Same gate as the thread list: a single comment and its replies are the
    // post's content, so the post's visibility rules decide who may read them.
    await assertCanViewPostById(comment.postId, req.user?._id || null);

    // ✅ FACEBOOK-STYLE THREADING: Fetch all descendants (recursively)
    let replies, totalReplies;

    // If this is a TOP-LEVEL comment, use optimized rootCommentId query
    if (!comment.parentCommentId) {
        // Fetch all replies using rootCommentId (more efficient for top-level)
        [replies, totalReplies] = await Promise.all([
            Comment.find({
                $or: [
                    { rootCommentId: commentId },
                    {
                        parentCommentId: commentId,
                        $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]
                    }
                ],
                isDeleted: false
            })
                .populate('userId', 'username fullName profileImageUrl')
                .populate('replyToUserId', 'username fullName profileImageUrl')
                .sort({ createdAt: 1 })
                .skip(skip)
                .limit(pageLimit)
                .lean(),
            Comment.countDocuments({
                $or: [
                    { rootCommentId: commentId },
                    {
                        parentCommentId: commentId,
                        $or: [{ rootCommentId: null }, { rootCommentId: { $exists: false } }]
                    }
                ],
                isDeleted: false
            })
        ]);
    } else {
        // For nested comments, recursively fetch all descendants
        const allDescendantIds = await getAllDescendantIds([commentId]);
        totalReplies = allDescendantIds.length;

        // Fetch and sort all descendants, then paginate
        replies = await Comment.find({ _id: { $in: allDescendantIds } })
            .populate('userId', 'username fullName profileImageUrl')
            .populate('replyToUserId', 'username fullName profileImageUrl')
            .sort({ createdAt: 1 })
            .skip(skip)
            .limit(pageLimit)
            .lean();
    }

    // Get likes for the main comment and all replies
    const allCommentIds = [commentId, ...replies.map(r => r._id)];
    const replyIds = replies.map(r => r._id);

    const [likes, replyCountsForReplies] = await Promise.all([
        Like.find({ commentId: { $in: allCommentIds } })
            .populate('userId', 'username profileImageUrl fullName')
            .lean(),
        // Get reply counts for each comment in the thread (how many direct replies each has)
        allCommentIds.length > 0
            ? Comment.aggregate([
                { $match: { parentCommentId: { $in: allCommentIds }, isDeleted: false } },
                { $group: { _id: '$parentCommentId', count: { $sum: 1 } } }
            ])
            : Promise.resolve([])
    ]);

    // Group likes by commentId
    const likesByComment = {};
    likes.forEach(like => {
        const cId = like.commentId.toString();
        if (!likesByComment[cId]) {
            likesByComment[cId] = [];
        }
        likesByComment[cId].push(like.userId);
    });

    // Group reply counts by commentId
    const replyCountMap = {};
    replyCountsForReplies.forEach(item => {
        replyCountMap[item._id.toString()] = item.count;
    });

    // ✅ Calculate depth for each reply (for nested display on frontend)
    const depthMap = { [commentId.toString()]: 0 }; // Root comment has depth 0
    const commentMap = {};

    // Build a map of comments by ID
    replies.forEach(reply => {
        commentMap[reply._id.toString()] = reply;
    });

    // Calculate depth by following parent chain
    const calculateDepth = (replyId) => {
        if (depthMap[replyId] !== undefined) return depthMap[replyId];

        const reply = commentMap[replyId];
        if (!reply || !reply.parentCommentId) {
            depthMap[replyId] = 1; // Direct reply to root
            return 1;
        }

        const parentId = reply.parentCommentId.toString();
        const parentDepth = parentId === commentId.toString()
            ? 0
            : calculateDepth(parentId);

        depthMap[replyId] = parentDepth + 1;
        return depthMap[replyId];
    };

    // Calculate depth for all replies
    replies.forEach(reply => {
        calculateDepth(reply._id.toString());
    });

    // Enrich main comment with likes and total reply count
    const commentLikes = likesByComment[commentId.toString()] || [];
    const isLikedBy = userId ? commentLikes.some(u => u._id.toString() === userId) : false;
    const enrichedComment = {
        ...comment,
        likes: commentLikes,
        isLikedBy,
        likesCount: commentLikes.length,
        replyCount: totalReplies
    };

    // Enrich replies with likes, reply counts, and depth for nested display
    const enrichedReplies = replies.map(reply => {
        const replyLikes = likesByComment[reply._id.toString()] || [];
        const isReplyLikedBy = userId ? replyLikes.some(u => u._id.toString() === userId) : false;

        return {
            ...reply,
            likes: replyLikes,
            isLikedBy: isReplyLikedBy,
            likesCount: replyLikes.length,
            replyCount: replyCountMap[reply._id.toString()] || 0,
            depth: depthMap[reply._id.toString()] || 1 // Add depth for nested UI rendering
        };
    });

    // Add badges to main comment and all replies
    const [commentWithBadges] = await addBadgesToNestedUsers([enrichedComment]);
    const repliesWithBadges = await addBadgesToNestedUsers(enrichedReplies);

    return res.status(200).json(
        new ApiResponse(200, {
            comment: commentWithBadges,
            replies: {
                totalReplies,
                page: pageNum,
                totalPages: Math.ceil(totalReplies / pageLimit),
                comments: repliesWithBadges
            }
        }, "Comment fetched successfully")
    );
});

/**
 * Who may touch someone else's comment.
 *
 * Neither updateComment nor deleteComment used to check anything beyond
 * verifyJWT, so any signed-in account could rewrite or erase any comment on the
 * platform just by knowing its id — which the comments list hands out. Editing
 * the text is the author's alone; removing a comment is also allowed to the
 * owner of the post it sits on, which is the moderation power the app already
 * offers post owners.
 */
const assertCommentAuthor = async (commentId, userId) => {
    assertValidCommentId(commentId);

    const comment = await Comment.findById(commentId).select("userId postId isDeleted");
    if (!comment || comment.isDeleted) throw new ApiError(404, "Comment not found");

    if (comment.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only edit your own comment");
    }

    return comment;
};

const assertCanDeleteComment = async (commentId, userId) => {
    assertValidCommentId(commentId);

    const comment = await Comment.findById(commentId).select("userId postId isDeleted");
    if (!comment) throw new ApiError(404, "Comment not found");

    if (comment.userId.toString() === userId.toString()) return comment;

    const post = await Post.findById(comment.postId).select("userId");
    if (post && post.userId.toString() === userId.toString()) return comment;

    throw new ApiError(403, "You can only delete your own comment");
};

// Update a comment
export const updateComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.params;
    const { content } = req.body;
    if (!content) throw new ApiError(400, "content is required");

    const existingComment = await assertCommentAuthor(commentId, userId);
    const previous = await Comment.findById(commentId).select('mentions').lean();
    const mentionIds = await resolveMentions({ texts: [content], authorId: userId });

    const comment = await Comment.findByIdAndUpdate(
        commentId,
        { content, isEdited: true, mentions: mentionIds },
        { new: true }
    )
        .populate('userId', 'username fullName profileImageUrl isBusinessProfile')
        .populate('replyToUserId', 'username fullName profileImageUrl isBusinessProfile')
        .lean();
    if (!comment || comment.isDeleted) throw new ApiError(404, "Comment not found");

    notifyMentions({
        mentionIds,
        previousIds: (previous?.mentions || []).map(String),
        authorId: userId,
        postId: existingComment.postId,
        commentId,
    }).catch(() => {});

    // Add badges to user and replyToUser
    const [commentWithBadges] = await addBadgesToNestedUsers([comment]);

    return res.status(200).json(new ApiResponse(200, commentWithBadges, "Comment updated successfully"));
});

// Delete a comment (soft delete)
export const deleteComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { commentId } = req.params;
    // Read first so an already-deleted comment cannot decrement the count twice
    // (this is a soft delete, so the document survives and can be re-submitted).
    // The same read also proves the caller is allowed to delete it.
    const existing = await assertCanDeleteComment(commentId, userId);

    const comment = await Comment.findByIdAndUpdate(
        commentId,
        { isDeleted: true },
        { new: true }
    );

    // A deleted comment can't stay pinned.
    await Post.updateOne({ _id: existing.postId, pinnedCommentId: existing._id }, { $set: { pinnedCommentId: null } });

    if (!existing.isDeleted) {
        const commentsCount = await adjustCommentsCount(existing.postId, -1);
        if (commentsCount !== null) socketManager.emitGlobal('post_engagement_updated', { postId: existing.postId.toString(), commentsCount });
    }

    return res.status(200).json(new ApiResponse(200, null, "Comment deleted successfully"));
}); 

/**
 * Pin one top-level comment to the top of a post (#53). Post owner only; a
 * new pin replaces the old one. PATCH /posts/:postId/pinned-comment { commentId }
 */
export const pinComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.params;
    const { commentId } = req.body || {};
    assertValidCommentId(commentId);

    const post = await assertCanViewPostById(postId, userId);
    if (String(post.userId) !== String(userId)) {
        throw new ApiError(403, "Only the creator can pin a comment");
    }

    const comment = await Comment.findOne({ _id: commentId, postId, isDeleted: false }).select('parentCommentId').lean();
    if (!comment) throw new ApiError(404, "Comment not found");
    if (comment.parentCommentId) throw new ApiError(400, "Only a top-level comment can be pinned, not a reply");

    await Post.updateOne({ _id: postId }, { $set: { pinnedCommentId: commentId } });
    invalidatePostCaches(postId, userId).catch(() => {});
    socketManager.emitGlobal('post_engagement_updated', { postId: String(postId), pinnedCommentId: String(commentId) });

    return res.status(200).json(new ApiResponse(200, { postId, pinnedCommentId: commentId }, "Comment pinned"));
});

/** DELETE /posts/:postId/pinned-comment */
export const unpinComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.params;
    const post = await assertCanViewPostById(postId, userId);
    if (String(post.userId) !== String(userId)) {
        throw new ApiError(403, "Only the creator can unpin a comment");
    }
    await Post.updateOne({ _id: postId }, { $set: { pinnedCommentId: null } });
    invalidatePostCaches(postId, userId).catch(() => {});
    socketManager.emitGlobal('post_engagement_updated', { postId: String(postId), pinnedCommentId: null });
    return res.status(200).json(new ApiResponse(200, { postId, pinnedCommentId: null }, "Comment unpinned"));
});
