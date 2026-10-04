import mongoose from 'mongoose';
import Post from '../models/userPost.models.js';
import PostBoost from '../models/postBoost.models.js';
import Order from '../models/order.models.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { resolvePlanTier } from '../utils/planLimits.js';
import {
    boostStateOf,
    evaluateBoostRequest,
    getBoostIneligibility,
    getBoostUsage,
    istDayKeysBetween,
    makeLedgerLoader,
    resolveBoostAccess
} from '../utils/boostEntitlement.js';
import { batchGetCommentsCount, batchGetLikesCount, batchSharedCount } from '../utils/postEngagement.utils.js';

const MY_BOOSTS_LIMIT = 100;
// Orders that represent money actually received, as opposed to unpaid or failed ones.
const PAID_ORDER_STATUSES = ['paid', 'held', 'released'];

const requireBoostId = (id) => {
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Boost not found');
};

const serializeBoost = (boost, now, post = null) => ({
    id: String(boost._id),
    postId: String(boost.postId),
    plan: boost.plan,
    status: boostStateOf(boost, now),
    startsAt: boost.startsAt,
    endsAt: boost.endsAt,
    cancelledAt: boost.cancelledAt ?? null,
    impressions: boost.impressions ?? 0,
    createdAt: boost.createdAt,
    post
});

/** Enough of each post to label a row in "My boosts". A deleted post comes back as null. */
const loadPostPreviews = async (postIds) => {
    const posts = await Post.find({ _id: { $in: postIds } })
        .select('caption contentType media customization.product.name customization.service.name customization.business.businessName')
        .lean();

    return new Map(posts.map((post) => {
        const cover = post.media?.[0];
        const title = post.customization?.[post.contentType]?.name
            || post.customization?.business?.businessName
            || post.caption
            || null;
        return [String(post._id), {
            id: String(post._id),
            contentType: post.contentType,
            title: title ? String(title).slice(0, 120) : null,
            thumbnailUrl: cover?.thumbnailUrl || (cover?.type === 'video' ? null : cover?.url) || null
        }];
    }));
};

/**
 * POST /boosts  { postId, days, startsAt? }
 *
 * Starts (or, for Corporate with a future startsAt, schedules) a boost of one of
 * the caller's own posts. Entitlement and limits live in utils/boostEntitlement.js.
 * Two requests racing each other can overshoot a limit by the number in flight;
 * that looseness is accepted, as it is for the monthly post cap.
 */
export const createBoost = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { postId, days, startsAt } = req.body || {};

    if (!mongoose.isValidObjectId(postId)) {
        throw new ApiError(400, 'Choose a post to boost.', { errorCode: 'BOOST_POST_REQUIRED' });
    }

    const { tier } = await resolveBoostAccess(userId);

    const post = await Post.findById(postId)
        .select('userId postType contentType settings.privacy status isReported')
        .lean();
    if (!post) throw new ApiError(404, 'Post not found');

    const ineligible = getBoostIneligibility(post, userId);
    if (ineligible) {
        throw new ApiError(ineligible.statusCode, ineligible.message, { errorCode: ineligible.errorCode });
    }

    const now = new Date();
    const window = await evaluateBoostRequest({
        tier,
        days,
        startsAt,
        now,
        // The stored id, not the request string: an uppercase-hex id is a valid
        // ObjectId but would never compare equal to the lowercase one in the ledger.
        postId: post._id,
        loadLedger: makeLedgerLoader(userId)
    });

    const boost = await PostBoost.create({
        postId: post._id,
        userId,
        plan: tier,
        startsAt: window.startsAt,
        endsAt: window.endsAt
    });

    const usage = await getBoostUsage(userId, { now });
    const scheduled = window.startsAt > now;

    return res.status(201).json(new ApiResponse(
        201,
        { boost: serializeBoost(boost.toObject(), now), usage },
        scheduled ? 'Your boost is scheduled.' : 'Your boost is live.'
    ));
});

/** GET /boosts/mine: the caller's boosts, newest first, with usage against their plan limits. */
export const getMyBoosts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const now = new Date();

    const [rows, usage] = await Promise.all([
        PostBoost.find({ userId }).sort({ startsAt: -1 }).limit(MY_BOOSTS_LIMIT).lean(),
        getBoostUsage(userId, { now })
    ]);
    const previews = rows.length ? await loadPostPreviews(rows.map((row) => row.postId)) : new Map();

    return res.status(200).json(new ApiResponse(
        200,
        { boosts: rows.map((row) => serializeBoost(row, now, previews.get(String(row.postId)) ?? null)), usage },
        'Boosts fetched successfully'
    ));
});

/**
 * GET /boosts/:id/report
 *
 * Every plan gets impressions and the post's likes, comments and shares. The
 * day-by-day series and the orders placed on the post while the boost ran are
 * Corporate. Impressions are times the post was served as promoted in the feed
 * and Explore; engagement is the post's totals right now, not just during the
 * boost.
 */
export const getBoostReport = asyncHandler(async (req, res) => {
    requireBoostId(req.params.id);
    const userId = req.user._id;

    const boost = await PostBoost.findOne({ _id: req.params.id, userId }).lean();
    if (!boost) throw new ApiError(404, 'Boost not found');

    const now = new Date();
    const tier = await resolvePlanTier(userId);
    const full = tier === 'corporate';
    // A cancelled boost stops counting at the moment it was cancelled.
    const reportEnd = new Date(Math.min(now.getTime(), boost.endsAt.getTime(), boost.cancelledAt ? boost.cancelledAt.getTime() : Infinity));

    const post = await Post.findById(boost.postId).select('engagement').lean();
    const items = post ? [post] : [];
    const [likes, comments, shares] = await Promise.all([
        batchGetLikesCount(items),
        batchGetCommentsCount(items),
        batchSharedCount(items)
    ]);
    const postKey = String(boost.postId);

    let daily = null;
    let orders = null;
    if (full) {
        const counts = boost.daily || {};
        daily = istDayKeysBetween(boost.startsAt, reportEnd).map((date) => ({ date, impressions: counts[date] ?? 0 }));

        const paidOrders = boost.startsAt < reportEnd
            ? await Order.find({
                sellerId: userId,
                postId: boost.postId,
                paymentStatus: { $in: PAID_ORDER_STATUSES },
                createdAt: { $gte: boost.startsAt, $lt: reportEnd }
            }).select('amount').lean()
            : [];
        orders = {
            count: paidOrders.length,
            orderValue: paidOrders.reduce((sum, order) => sum + (order.amount || 0), 0),
            currency: 'INR'
        };
    }

    return res.status(200).json(new ApiResponse(
        200,
        {
            boost: serializeBoost(boost, now),
            totals: {
                impressions: boost.impressions ?? 0,
                likes: likes.get(postKey) ?? 0,
                comments: comments.get(postKey) ?? 0,
                shares: shares.get(postKey) ?? 0
            },
            daily,
            orders,
            detail: full ? 'full' : 'basic'
        },
        'Boost report fetched successfully'
    ));
});

/**
 * DELETE /boosts/:id: stops a boost now. A cancelled boost still counts towards
 * the plan's monthly total, so cancelling and re-starting is not a way round it.
 */
export const cancelBoost = asyncHandler(async (req, res) => {
    requireBoostId(req.params.id);
    const userId = req.user._id;
    const now = new Date();

    const cancelled = await PostBoost.findOneAndUpdate(
        { _id: req.params.id, userId, cancelledAt: null, endsAt: { $gt: now } },
        { $set: { cancelledAt: now, cancelReason: 'user' } },
        { new: true }
    ).lean();

    if (!cancelled) {
        const existing = await PostBoost.findOne({ _id: req.params.id, userId }).select('_id').lean();
        if (!existing) throw new ApiError(404, 'Boost not found');
        throw new ApiError(409, 'This boost has already ended or been cancelled.', { errorCode: 'BOOST_NOT_ACTIVE' });
    }

    return res.status(200).json(new ApiResponse(
        200,
        { boost: serializeBoost(cancelled, now), usage: await getBoostUsage(userId, { now }) },
        'Boost cancelled'
    ));
});
