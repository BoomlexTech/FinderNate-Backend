import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import NotInterested from '../models/notInterested.models.js';
import { User } from '../models/user.models.js';
import { assertCanViewPostById } from './post/visibility.js';
import { invalidateFeedSignals } from '../utils/feedSignals.utils.js';
import { FeedCacheManager } from '../utils/cache.utils.js';
import { resetReelsCache } from './reel.controllers.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { DEFAULT_CONTENT_CATEGORIES, MAX_PREFERRED_CATEGORIES } from '../constants/contentCategories.js';
import Post from '../models/userPost.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { getFollowingIdSet } from '../utils/followEngagement.utils.js';

const refreshFeedsFor = async (userId) => {
    await Promise.allSettled([
        invalidateFeedSignals(userId),
        FeedCacheManager.invalidateUserFeed(userId),
    ]);
    resetReelsCache();
};

// ── Categories (#26) ─────────────────────────────────────────────────────────

export const getContentCategoryList = async () => {
    const list = await getSettingValue('CONTENT_CATEGORIES', DEFAULT_CONTENT_CATEGORIES);
    return Array.isArray(list) && list.length ? list : [...DEFAULT_CONTENT_CATEGORIES];
};

/** GET /api/v1/meta/categories — public. */
export const getContentCategories = asyncHandler(async (req, res) => {
    const categories = await getContentCategoryList();
    res.set('Cache-Control', 'public, max-age=300');
    return res.status(200).json(new ApiResponse(200, { categories }, 'Categories fetched'));
});

/**
 * Keep only names from the current list (matched case-insensitively, stored
 * in the list's spelling), de-duplicated, at most 10. Pure.
 */
export const pickCategories = (requested, available) => {
    const byKey = new Map(available.map((c) => [String(c).toLowerCase(), c]));
    const out = [];
    for (const raw of Array.isArray(requested) ? requested : []) {
        const hit = byKey.get(String(raw ?? '').trim().toLowerCase());
        if (hit && !out.includes(hit)) out.push(hit);
        if (out.length >= MAX_PREFERRED_CATEGORIES) break;
    }
    return out;
};

/** GET /api/v1/users/me/categories */
export const getMyCategoryPreferences = asyncHandler(async (req, res) => {
    const [user, categories] = await Promise.all([
        User.findById(req.user._id).select('preferredCategories').lean(),
        getContentCategoryList(),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        preferredCategories: user?.preferredCategories || [],
        categories,
        max: MAX_PREFERRED_CATEGORIES,
    }, 'Category preferences fetched'));
});

/** PUT /api/v1/users/me/categories { categories: [...] } — an empty list clears them. */
export const updateMyCategoryPreferences = asyncHandler(async (req, res) => {
    const requested = req.body?.categories;
    if (!Array.isArray(requested)) throw new ApiError(400, 'categories must be a list');
    const preferredCategories = pickCategories(requested, await getContentCategoryList());
    await User.updateOne({ _id: req.user._id }, { $set: { preferredCategories } });
    await refreshFeedsFor(req.user._id);
    return res.status(200).json(new ApiResponse(200, { preferredCategories }, 'Category preferences saved'));
});

// ── Not interested (#68) ─────────────────────────────────────────────────────

/** POST /api/v1/posts/:postId/not-interested */
export const markNotInterested = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.params;
    const post = await assertCanViewPostById(postId, userId);
    if (String(post.userId) === String(userId)) {
        throw new ApiError(400, "You can't mark your own post as not interested");
    }
    await NotInterested.updateOne(
        { userId, postId },
        {
            $set: {
                authorId: post.userId,
                category: post.category || null,
                hashtags: (post.hashtags || []).slice(0, 20),
                createdAt: new Date(),
            },
        },
        { upsert: true },
    );
    await refreshFeedsFor(userId);
    return res.status(200).json(new ApiResponse(200, { postId, notInterested: true }, "We'll show you fewer posts like this"));
});

/** DELETE /api/v1/posts/:postId/not-interested — the Undo. */
export const undoNotInterested = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(404, 'Post not found');
    await NotInterested.deleteOne({ userId, postId });
    await refreshFeedsFor(userId);
    return res.status(200).json(new ApiResponse(200, { postId, notInterested: false }, 'Undone'));
});

// ── New-post ring (#55) ──────────────────────────────────────────────────────

const RING_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * GET /api/v1/users/me/new-post-ring — creators the caller follows who
 * posted in the last 3 days something the caller hasn't opened yet. The
 * clients draw a glowing ring (not the story ring) around them. Opening one
 * of those posts records a view, which clears the ring on the next fetch.
 */
export const getNewPostRing = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const following = [...(await getFollowingIdSet(userId))]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
    if (!following.length) return res.status(200).json(new ApiResponse(200, { creators: [] }, 'Nothing new'));

    const since = new Date(Date.now() - RING_WINDOW_MS);
    const recent = await Post.aggregate([
        {
            $match: {
                userId: { $in: following },
                createdAt: { $gte: since },
                status: { $in: ['published', null] },
                'settings.privacy': { $ne: 'private' },
                postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
            },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', latestAt: { $first: '$createdAt' }, postIds: { $push: '$_id' } } },
        { $project: { latestAt: 1, postIds: { $slice: ['$postIds', 20] } } },
        { $sort: { latestAt: -1 } },
        { $limit: 60 },
    ]);
    if (!recent.length) return res.status(200).json(new ApiResponse(200, { creators: [] }, 'Nothing new'));

    const seen = await PostInteraction.find({
        userId,
        interactionType: 'view',
        postId: { $in: recent.flatMap((r) => r.postIds) },
    }).select('postId').lean();
    const seenSet = new Set(seen.map((s) => String(s.postId)));

    const withUnseen = recent
        .map((r) => ({ userId: r._id, latestAt: r.latestAt, unseenPostIds: r.postIds.filter((id) => !seenSet.has(String(id))) }))
        .filter((r) => r.unseenPostIds.length)
        .slice(0, 30);
    const users = await User.find({ _id: { $in: withUnseen.map((r) => r.userId) }, isDeleted: { $ne: true }, accountStatus: 'active' })
        .select('username fullName profileImageUrl').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return res.status(200).json(new ApiResponse(200, {
        creators: withUnseen
            .filter((r) => byId.has(String(r.userId)))
            .map((r) => ({
                user: byId.get(String(r.userId)),
                latestAt: r.latestAt,
                unseenCount: r.unseenPostIds.length,
                latestPostId: r.unseenPostIds[0],
            })),
    }, 'New posts from people you follow'));
});
