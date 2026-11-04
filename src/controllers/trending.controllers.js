import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { getTrendingTopics, getTrendingPlaceIds } from '../services/trending.service.js';
import { createPostVisibilityChecker } from './post/visibility.js';
import { filterBusinessPostsByPaymentPlan } from '../utils/businessPlan.utils.js';
import { batchGetLikesCount, batchIsLikedByUser } from '../utils/postEngagement.utils.js';
import { annotateSeen } from '../utils/seenFlags.utils.js';
import { attachCollaborators } from '../utils/collab.utils.js';
import { cityKey, discountOf, cleanTagQuery } from '../utils/suggestions.utils.js';

const CARD_FIELDS = 'userId postType contentType caption description media category hashtags createdAt engagement settings.privacy settings.allowLikes settings.allowComments settings.allowShares customization.product customization.service.name customization.service.price customization.service.currency customization.business.businessName collaborators music duet settings.allowDuets';

/**
 * Load posts by id for a discovery surface, in that order, minus anything
 * this viewer may not see: private or blocked, and listings from businesses
 * without a plan (the same discovery rule explore and search use).
 */
export const loadCards = async (ids, req, limit) => {
    const viewerId = req.user?._id || null;
    const blocked = new Set((req.blockedUsers || []).map(String));
    const valid = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!valid.length) return [];
    const docs = await Post.find({ _id: { $in: valid } }).select(CARD_FIELDS)
        .populate('userId', 'username fullName profileImageUrl').lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const canView = createPostVisibilityChecker(viewerId);
    const ordered = [];
    for (const id of valid) {
        const post = byId.get(String(id));
        if (!post?.userId || blocked.has(String(post.userId._id))) continue;
        if (await canView(post)) ordered.push(post);
    }
    const allowed = (await filterBusinessPostsByPaymentPlan(ordered, req.user?._id)).slice(0, limit);
    const [likeCounts, likedSet] = await Promise.all([
        batchGetLikesCount(allowed),
        viewerId ? batchIsLikedByUser(viewerId, allowed.map((p) => p._id)) : Promise.resolve(new Set()),
    ]);
    for (const post of allowed) {
        const idStr = String(post._id);
        post.media = (post.media || []).slice(0, 1);
        post.engagement = { ...(post.engagement || {}), likes: likeCounts.get(idStr) ?? post.engagement?.likes ?? 0 };
        post.isLikedBy = likedSet.has(idStr);
        const discount = post.contentType === 'product' ? discountOf(post.customization?.product) : 0;
        if (discount) post.discountPercent = Math.round(discount * 100);
        delete post.settings?.privacy;
    }
    await attachCollaborators(allowed, viewerId);
    await annotateSeen(allowed, viewerId);
    return allowed;
};

/** GET /explore/trending-topics — top 10 hashtags, refreshed every 30 minutes (#58). */
export const getTrendingTopicsHandler = asyncHandler(async (req, res) => {
    const data = await getTrendingTopics();
    return res.status(200).json(new ApiResponse(200, data, 'Trending topics'));
});

/** GET /explore/hashtag/:tag?page&limit — newest public posts with that tag. */
export const getHashtagPosts = asyncHandler(async (req, res) => {
    const tag = cleanTagQuery(req.params.tag);
    if (!tag) throw new ApiError(400, 'Which hashtag?');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rows = await Post.find({ hashtags: tag, 'settings.privacy': { $ne: 'private' }, status: { $in: ['published', null] } })
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit * 2).select('_id').lean();
    const posts = await loadCards(rows.map((r) => String(r._id)), req, limit);
    return res.status(200).json(new ApiResponse(200, {
        tag,
        posts,
        pagination: { page, limit, hasMore: rows.length >= limit },
    }, `Posts tagged #${tag}`));
});

/**
 * GET /explore/trending-near-you?city= — what's trending and the hot deals in
 * a city (#42). The city is the one asked for, else the viewer's profile
 * location; with neither, or when the city is too quiet, it's nationwide.
 * The apps don't read device location.
 */
export const getTrendingNearYou = asyncHandler(async (req, res) => {
    let city = cityKey(req.query.city);
    let source = city ? 'chosen' : null;
    if (!city && req.user?._id) {
        const me = await User.findById(req.user._id).select('location').lean();
        city = cityKey(me?.location);
        if (city) source = 'profile';
    }
    const { local, all } = await getTrendingPlaceIds(city);
    const useLocal = !!local && (local.trending?.length || 0) >= 3;
    const pick = useLocal ? local : all;
    const [trending, deals] = await Promise.all([
        loadCards(pick?.trending || [], req, 12),
        loadCards((useLocal && local.deals?.length ? local.deals : all?.deals) || [], req, 12),
    ]);
    const label = useLocal ? city.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : null;
    return res.status(200).json(new ApiResponse(200, {
        city: useLocal ? city : null,
        cityLabel: label,
        citySource: useLocal ? source : null,
        scope: useLocal ? 'city' : 'nationwide',
        trending,
        deals,
        updatedAt: pick?.updatedAt || null,
    }, useLocal ? `Trending in ${label}` : 'Trending on Findernate'));
});
