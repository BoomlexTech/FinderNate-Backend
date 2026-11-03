import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import PostInteraction from '../models/postInteraction.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { createPostVisibilityChecker } from './post/visibility.js';
import { forgetHistoryPause } from './postInteraction.controllers.js';

/**
 * Watch history (Phase 2 #14): what the caller opened, newest first, from
 * the 'view' interactions (kept 90 days). Clearing history deletes those rows,
 * which also resets the "seen" flags (#33) for those posts.
 */

const VIBE_TYPES = ['reel', 'video'];
/** postType filter for ?type=posts|vibes (anything else = all). Pure. */
export const historyTypeFilter = (type) => {
    if (type === 'vibes') return { postType: { $in: VIBE_TYPES } };
    if (type === 'posts') return { postType: { $nin: VIBE_TYPES } };
    return {};
};

/** GET /users/me/history?type=posts|vibes&page&limit */
export const getWatchHistory = asyncHandler(async (req, res) => {
    const userId = new mongoose.Types.ObjectId(String(req.user._id));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const typeFilter = historyTypeFilter(req.query.type);

    const rows = await PostInteraction.aggregate([
        { $match: { userId, interactionType: 'view' } },
        { $sort: { lastInteracted: -1 } },
        { $limit: 2000 },
        {
            $lookup: {
                from: 'posts', localField: 'postId', foreignField: '_id', as: 'post',
                pipeline: [
                    { $match: typeFilter },
                    {
                        $project: {
                            userId: 1, postType: 1, contentType: 1, caption: 1, description: 1, createdAt: 1,
                            'settings.privacy': 1,
                            media: { $slice: ['$media', 1] },
                            'customization.product.name': 1, 'customization.product.price': 1, 'customization.product.currency': 1,
                            'customization.service.name': 1, 'customization.service.price': 1, 'customization.service.currency': 1,
                        },
                    },
                ],
            },
        },
        { $unwind: '$post' },
        { $skip: (page - 1) * limit },
        { $limit: limit + 1 },
    ]);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const canView = createPostVisibilityChecker(req.user._id);
    const visible = [];
    for (const row of pageRows) {
        if (await canView(row.post)) visible.push(row);
    }
    const authorIds = [...new Set(visible.map((r) => String(r.post.userId)))];
    const authors = await User.find({ _id: { $in: authorIds } }).select('username fullName profileImageUrl').lean();
    const authorById = new Map(authors.map((a) => [String(a._id), a]));

    const [paused] = await Promise.all([User.exists({ _id: req.user._id, historyPaused: true })]);

    return res.status(200).json(new ApiResponse(200, {
        items: visible.map((r) => ({
            postId: r.post._id,
            viewedAt: r.lastInteracted,
            post: { ...r.post, userId: authorById.get(String(r.post.userId)) || null },
        })),
        paused: !!paused,
        pagination: { page, limit, hasMore },
    }, 'History fetched'));
});

/** DELETE /users/me/history/:postId */
export const removeFromHistory = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(404, 'Not in your history');
    await PostInteraction.deleteMany({ userId: req.user._id, postId, interactionType: 'view' });
    return res.status(200).json(new ApiResponse(200, { postId }, 'Removed from history'));
});

/** DELETE /users/me/history?type=posts|vibes (no type = everything) */
export const clearHistory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const typeFilter = historyTypeFilter(req.query.type);
    let deleted = 0;
    if (!Object.keys(typeFilter).length) {
        deleted = (await PostInteraction.deleteMany({ userId, interactionType: 'view' })).deletedCount;
    } else {
        // Only the views of that kind of post.
        const viewed = await PostInteraction.find({ userId, interactionType: 'view' }).select('postId').limit(20000).lean();
        const ofType = await Post.find({ _id: { $in: viewed.map((v) => v.postId) }, ...typeFilter }).select('_id').lean();
        if (ofType.length) {
            deleted = (await PostInteraction.deleteMany({ userId, interactionType: 'view', postId: { $in: ofType.map((p) => p._id) } })).deletedCount;
        }
    }
    return res.status(200).json(new ApiResponse(200, { deleted }, 'History cleared'));
});

/** PATCH /users/me/history/settings { paused } */
export const updateHistorySettings = asyncHandler(async (req, res) => {
    const { paused } = req.body || {};
    if (typeof paused !== 'boolean') throw new ApiError(400, 'paused must be true or false');
    await User.updateOne({ _id: req.user._id }, { $set: { historyPaused: paused } });
    forgetHistoryPause(req.user._id);
    return res.status(200).json(new ApiResponse(200, { paused }, paused ? 'History paused' : 'History turned back on'));
});
