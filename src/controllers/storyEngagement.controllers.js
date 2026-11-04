import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Story from '../models/story.models.js';
import StoryComment from '../models/storyComment.models.js';
import { User } from '../models/user.models.js';
import Follower from '../models/follower.models.js';
import Block from '../models/block.models.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { isStoryLive, MAX_STORY_COMMENT_LENGTH } from '../utils/storyEngagement.utils.js';
import { buildSharedPostSnapshot, recordPostShare } from '../utils/sharedPost.utils.js';

/**
 * Story likes, comments and reposts (Phase 2 #32, #56).
 *
 * Others can like or comment only while a story is live. The owner keeps
 * seeing likes, comments and viewers afterwards, in the archive: a story with
 * likes or comments is archived instead of deleted when it expires
 * (jobs/storyExpiry.job.js). Comments are visible to the owner and to the
 * person who wrote them, nobody else.
 */

const loadStory = async (storyId) => {
    if (!mongoose.Types.ObjectId.isValid(String(storyId))) throw new ApiError(404, 'Story not found');
    const story = await Story.findById(storyId).select('userId isArchived expiresAt commentsCount likedBy sharedPost').lean();
    if (!story) throw new ApiError(404, 'Story not found');
    return story;
};

/**
 * Same audience rules as opening a story (markStorySeen): not blocked either
 * way, the author's account is active, and for a private account the two are
 * connected by a follow in either direction.
 */
export const assertCanEngage = async (story, userId) => {
    const ownerId = story.userId;
    if (String(ownerId) === String(userId)) return;
    if (!isStoryLive(story)) throw new ApiError(410, 'This story is no longer available');
    const [owner, blocked] = await Promise.all([
        User.findById(ownerId).select('privacy isFullPrivate accountStatus isDeleted').lean(),
        Block.exists({ $or: [{ blockerId: ownerId, blockedId: userId }, { blockerId: userId, blockedId: ownerId }] }),
    ]);
    if (!owner || owner.isDeleted || ['deactivated', 'banned'].includes(owner.accountStatus) || blocked) {
        throw new ApiError(403, "You can't interact with this story");
    }
    if (owner.privacy === 'private' || owner.isFullPrivate === true) {
        const connected = await Follower.exists({
            $or: [{ userId: ownerId, followerId: userId }, { userId, followerId: ownerId }],
        });
        if (!connected) throw new ApiError(403, "You can't interact with this story");
    }
};

const assertOwner = (story, userId) => {
    if (String(story.userId) !== String(userId)) throw new ApiError(403, 'Only the person who posted this story can see that');
};

/** POST /stories/:storyId/like */
export const likeStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const story = await loadStory(req.params.storyId);
    await assertCanEngage(story, userId);
    const result = await Story.updateOne({ _id: story._id }, { $addToSet: { likedBy: userId } });
    if (result.modifiedCount) {
        notifyActivity({
            recipientId: story.userId,
            senderId: userId,
            type: 'story_like',
            message: 'liked your story',
            storyId: story._id,
            push: { title: 'Story like', url: '/notifications' },
        }).catch(() => {});
    }
    const likesCount = (story.likedBy?.length || 0) + (result.modifiedCount ? 1 : 0);
    return res.status(200).json(new ApiResponse(200, { storyId: story._id, isLiked: true, likesCount }, 'Story liked'));
});

/** DELETE /stories/:storyId/like */
export const unlikeStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const story = await loadStory(req.params.storyId);
    const result = await Story.updateOne({ _id: story._id }, { $pull: { likedBy: userId } });
    const likesCount = Math.max(0, (story.likedBy?.length || 0) - (result.modifiedCount ? 1 : 0));
    return res.status(200).json(new ApiResponse(200, { storyId: story._id, isLiked: false, likesCount }, 'Like removed'));
});

/** GET /stories/:storyId/likes — owner only, works on archived stories too. */
export const getStoryLikes = asyncHandler(async (req, res) => {
    const story = await loadStory(req.params.storyId);
    assertOwner(story, req.user._id);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const ids = (story.likedBy || []).slice().reverse();
    const pageIds = ids.slice((page - 1) * limit, page * limit);
    const users = await User.find({ _id: { $in: pageIds } }).select('username fullName profileImageUrl').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return res.status(200).json(new ApiResponse(200, {
        users: pageIds.map((id) => byId.get(String(id))).filter(Boolean),
        pagination: { page, limit, total: ids.length, totalPages: Math.ceil(ids.length / limit) },
    }, 'Story likes fetched'));
});

/** POST /stories/:storyId/comments { content } */
export const commentOnStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) throw new ApiError(400, 'Write a comment first');
    if (content.length > MAX_STORY_COMMENT_LENGTH) throw new ApiError(400, `Comments can be up to ${MAX_STORY_COMMENT_LENGTH} characters`);
    const story = await loadStory(req.params.storyId);
    await assertCanEngage(story, userId);

    const comment = await StoryComment.create({ storyId: story._id, storyOwnerId: story.userId, userId, content });
    await Story.updateOne({ _id: story._id }, { $inc: { commentsCount: 1 } });
    notifyActivity({
        recipientId: story.userId,
        senderId: userId,
        type: 'story_comment',
        message: 'commented on your story',
        storyId: story._id,
        data: { preview: content.slice(0, 80) },
        push: { title: 'Story comment', url: '/notifications' },
    }).catch(() => {});

    const populated = await StoryComment.findById(comment._id).populate('userId', 'username fullName profileImageUrl').lean();
    return res.status(201).json(new ApiResponse(201, populated, 'Comment sent'));
});

/**
 * GET /stories/:storyId/comments — the owner sees every comment (also on
 * archived stories); anyone else sees only their own.
 */
export const getStoryComments = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const story = await loadStory(req.params.storyId);
    const isOwner = String(story.userId) === String(userId);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const filter = { storyId: story._id, ...(isOwner ? {} : { userId }) };
    const [comments, total] = await Promise.all([
        StoryComment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
            .populate('userId', 'username fullName profileImageUrl').lean(),
        StoryComment.countDocuments(filter),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        comments,
        isOwner,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Story comments fetched'));
});

/** DELETE /stories/:storyId/comments/:commentId — the owner or the author. */
export const deleteStoryComment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { storyId, commentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(commentId))) throw new ApiError(404, 'Comment not found');
    const comment = await StoryComment.findOne({ _id: commentId, storyId }).lean();
    if (!comment) throw new ApiError(404, 'Comment not found');
    if (String(comment.userId) !== String(userId) && String(comment.storyOwnerId) !== String(userId)) {
        throw new ApiError(403, 'You can only delete your own comment');
    }
    await StoryComment.deleteOne({ _id: comment._id });
    await Story.updateOne({ _id: storyId, commentsCount: { $gt: 0 } }, { $inc: { commentsCount: -1 } });
    return res.status(200).json(new ApiResponse(200, { commentId }, 'Comment deleted'));
});

/**
 * POST /stories/repost { postId, caption? } — share a post or vibe to your
 * own story (#56). The story shows the original as a card, credits its
 * creator, and taps through to it. Respects the author's sharing switch.
 */
export const repostToStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.body || {};
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 200) : '';
    const snapshot = await buildSharedPostSnapshot(postId, userId);
    const author = await User.findById(snapshot.authorId).select('profileImageUrl').lean();

    const story = await Story.create({
        userId,
        // The card's picture. Not owned by this story, so never deleted with
        // it (see Story.sharedPost and the expiry job).
        mediaUrl: snapshot.thumbnailUrl || author?.profileImageUrl || 'https://findernate.com/icon-512x512.png',
        mediaType: 'image',
        caption,
        sharedPost: snapshot,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    recordPostShare(postId, userId).catch(() => {});
    notifyActivity({
        recipientId: snapshot.authorId,
        senderId: userId,
        type: 'repost',
        message: snapshot.isVibe ? 'shared your vibe to their story' : 'shared your post to their story',
        postId: snapshot.postId,
        storyId: story._id,
        push: { title: 'Shared to a story' },
    }).catch(() => {});

    const out = story.toObject();
    out.postType = out.mediaType;
    delete out.mediaType;
    delete out.viewers;
    delete out.likedBy;
    return res.status(201).json(new ApiResponse(201, out, 'Shared to your story'));
});
