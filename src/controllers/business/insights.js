import mongoose from "mongoose";
import Post from "../../models/userPost.models.js";
import Like from "../../models/like.models.js";
import Comment from "../../models/comment.models.js";
import SavedPost from "../../models/savedPost.models.js";
import Follower from "../../models/follower.models.js";
import PostInteraction from "../../models/postInteraction.models.js";
import ContactRequest from "../../models/contactRequest.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { redisClient } from "../../config/redis.config.js";
import { getFollowersCount } from "../../utils/followEngagement.utils.js";
import { PAID_TIERS, PLAN_LIMITS, TIER_NAMES, resolvePlanTier } from "../../utils/planLimits.js";
import {
    IST_MONGO_TIMEZONE,
    POST_ANALYSIS_CAP,
    WEEKDAY_NAMES,
    bestPostType,
    busiestSlot,
    buildDailySeries,
    buildFollowerGrowth,
    buildInsightsCsv,
    buildPostRow,
    buildTypeBreakdown,
    buildWindow,
    canCompareShares,
    comparisonMetric,
    getLockedSections,
    istDayKey,
    paginate,
    parsePaging,
    resolveRange,
    resolveSort,
    sortRows,
    sumIntoSlots,
    tierAtLeast,
    topPosts
} from "./insightsHelpers.js";

// The work behind one response is a dozen collection scans, so it is cached.
// Keyed by user, range and tier: an upgrade or lapse shows up on the next call.
const CACHE_TTL_SECONDS = 5 * 60;
const cacheKey = (userId, days, tier) => `fn:insights:${userId}:${days}:${tier}`;

// A cache problem must never fail the request: on any Redis error the numbers
// are simply computed again.
const readCache = async (key) => {
    try {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.error("[Insights] cache read failed:", err.message);
        return null;
    }
};

const writeCache = async (key, bundle) => {
    try {
        await redisClient.set(key, JSON.stringify(bundle), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
        console.error("[Insights] cache write failed:", err.message);
    }
};

const DAY_EXPRESSION = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: IST_MONGO_TIMEZONE } };

// Likes, comments, saves and shares are all counted the same way: grouped by
// day (for the trend), by post (for the rankings) and, for Corporate, by hour
// and weekday in IST. $facet does that in one pass over the matched rows.
const engagementFacets = (withTimeOfDay) => {
    const count = (id) => [{ $group: { _id: id, n: { $sum: 1 } } }];
    const facets = {
        byDay: count(DAY_EXPRESSION),
        byPost: count("$postId")
    };
    if (withTimeOfDay) {
        facets.byHour = count({ $hour: { date: "$createdAt", timezone: IST_MONGO_TIMEZONE } });
        facets.byWeekday = count({ $dayOfWeek: { date: "$createdAt", timezone: IST_MONGO_TIMEZONE } });
    }
    return facets;
};

const EMPTY_FACETS = { byDay: [], byPost: [], byHour: [], byWeekday: [] };

const aggregateEngagement = async (Model, match, postIds, withTimeOfDay) => {
    if (!postIds.length) return EMPTY_FACETS;
    const [facets] = await Model.aggregate([{ $match: match }, { $facet: engagementFacets(withTimeOfDay) }]);
    return { ...EMPTY_FACETS, ...facets };
};

const countOnPosts = (Model, match, postIds) => (postIds.length ? Model.countDocuments(match) : 0);

const PUBLISHED = { status: { $nin: ["draft", "scheduled"] } };

const POST_FIELDS =
    "postType contentType caption description createdAt engagement.likes engagement.comments engagement.shares media.type media.url media.thumbnailUrl";

// verifyJWT serves req.user from a Redis copy, so on a cache hit the ids are
// strings. find/countDocuments cast them, but an aggregation $match does not: a
// string never equals an ObjectId and the stage quietly matches nothing.
const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

const sumCounts = (rows) => rows.reduce((sum, row) => sum + row.n, 0);

const byPostCounts = (facets) => new Map(facets.byPost.map((row) => [String(row._id), row.n]));

const buildInsights = async (user, tier, days) => {
    const userId = toObjectId(user._id);
    const window = buildWindow(days);
    const advanced = tierAtLeast(tier, "small_business");
    const corporate = tier === "corporate";

    const current = { $gte: window.start, $lte: window.end };
    const ownPosts = { userId, ...PUBLISHED };

    const [posts, postsTotal, postsPublished, followersTotal, newFollowers] = await Promise.all([
        Post.find(ownPosts).sort({ createdAt: -1 }).limit(POST_ANALYSIS_CAP).select(POST_FIELDS).lean(),
        Post.countDocuments(ownPosts),
        Post.countDocuments({ ...ownPosts, createdAt: current }),
        getFollowersCount(userId),
        Follower.countDocuments({ userId, createdAt: current })
    ]);

    const postIds = posts.map((post) => post._id);
    const onPosts = (range, extra = {}) => ({ postId: { $in: postIds }, userId: { $ne: userId }, createdAt: range, ...extra });
    const likesMatch = onPosts(current);
    const commentsMatch = onPosts(current, { isDeleted: { $ne: true } });

    const payload = {
        tier,
        rangeApplied: days,
        maxRangeDays: PLAN_LIMITS[tier].insightsMaxDays,
        generatedAt: new Date().toISOString(),
        timezone: "Asia/Kolkata",
        period: { from: window.dayKeys[0], to: window.dayKeys[window.dayKeys.length - 1] },
        postsAnalysed: posts.length,
        postsCapped: postsTotal > posts.length,
        locked: getLockedSections(tier)
    };

    if (!advanced) {
        const [likes, comments] = await Promise.all([
            countOnPosts(Like, likesMatch, postIds),
            countOnPosts(Comment, commentsMatch, postIds)
        ]);
        payload.summary = { followersTotal, newFollowers, likes, comments, postsPublished, postsTotal };
        return { payload };
    }

    const savesMatch = onPosts(current);
    const sharesMatch = onPosts(current, { interactionType: "share" });

    const [likeFacets, commentFacets, saveFacets, shareFacets, newFollowerDays, leads] = await Promise.all([
        aggregateEngagement(Like, likesMatch, postIds, corporate),
        aggregateEngagement(Comment, commentsMatch, postIds, corporate),
        aggregateEngagement(SavedPost, savesMatch, postIds, corporate),
        aggregateEngagement(PostInteraction, sharesMatch, postIds, false),
        Follower.aggregate([
            { $match: { userId, createdAt: current } },
            { $group: { _id: DAY_EXPRESSION, n: { $sum: 1 } } }
        ]),
        loadLeads(user, current)
    ]);

    const likeCounts = byPostCounts(likeFacets);
    const commentCounts = byPostCounts(commentFacets);
    const saveCounts = byPostCounts(saveFacets);
    const shareCounts = byPostCounts(shareFacets);

    const rows = posts.map((post) => {
        const id = String(post._id);
        return buildPostRow(post, {
            likes: likeCounts.get(id),
            comments: commentCounts.get(id),
            saves: saveCounts.get(id),
            shares: shareCounts.get(id)
        });
    });

    const totals = {
        likes: sumCounts(likeFacets.byPost),
        comments: sumCounts(commentFacets.byPost),
        saves: sumCounts(saveFacets.byPost),
        shares: sumCounts(shareFacets.byPost)
    };

    const series = buildDailySeries(window.dayKeys, {
        newFollowers: newFollowerDays,
        likes: likeFacets.byDay,
        comments: commentFacets.byDay,
        saves: saveFacets.byDay,
        shares: shareFacets.byDay
    });

    payload.summary = { followersTotal, newFollowers, ...totals, postsPublished, postsTotal };
    payload.series = series;
    payload.topPosts = topPosts(rows);
    payload.leads = leads;

    if (!corporate) return { payload };

    const comparison = await loadComparison({ userId, ownPosts, postIds, window, onPosts, summary: payload.summary });
    const breakdown = {
        contentType: buildTypeBreakdown(rows, "contentType"),
        postType: buildTypeBreakdown(rows, "postType")
    };

    const hourly = sumIntoSlots([likeFacets.byHour, commentFacets.byHour, saveFacets.byHour], 24);
    // Mongo numbers weekdays 1 (Sunday) to 7 (Saturday).
    const weekday = sumIntoSlots([likeFacets.byWeekday, commentFacets.byWeekday, saveFacets.byWeekday], 7, 1);
    const bestHour = busiestSlot(hourly);
    const bestDay = busiestSlot(weekday);

    payload.comparison = comparison;
    payload.breakdown = breakdown;
    payload.insights = {
        hourly,
        weekday,
        bestHour: bestHour && { hour: bestHour.index, count: bestHour.count },
        bestDay: bestDay && { day: bestDay.index, name: WEEKDAY_NAMES[bestDay.index], count: bestDay.count },
        topPostType: bestPostType(breakdown.postType),
        followerGrowth: buildFollowerGrowth(series)
    };

    return { payload, rows };
};

const loadLeads = async (user, range) => {
    const [enquiryRows, [rating]] = await Promise.all([
        ContactRequest.aggregate([
            { $match: { businessOwner: toObjectId(user._id), createdAt: range } },
            { $group: { _id: "$status", n: { $sum: 1 } } }
        ]),
        BusinessRating.aggregate([
            { $match: { businessId: toObjectId(user.businessProfileId), createdAt: range } },
            { $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$rating" } } }
        ])
    ]);

    const byStatus = Object.fromEntries(enquiryRows.map((row) => [row._id, row.n]));
    return {
        enquiries: {
            received: sumCounts(enquiryRows),
            pending: byStatus.pending || 0,
            approved: byStatus.approved || 0,
            denied: byStatus.denied || 0
        },
        ratings: {
            newCount: rating?.count || 0,
            average: rating ? Math.round(rating.average * 10) / 10 : null
        }
    };
};

// Every headline metric against the window of equal length just before it.
// Shares come back null when that earlier window reaches past the point share
// records are kept to.
const loadComparison = async ({ userId, ownPosts, postIds, window, onPosts, summary }) => {
    const previous = { $gte: window.previousStart, $lt: window.previousEnd };

    const [newFollowers, likes, comments, saves, shares, postsPublished] = await Promise.all([
        Follower.countDocuments({ userId, createdAt: previous }),
        countOnPosts(Like, onPosts(previous), postIds),
        countOnPosts(Comment, onPosts(previous, { isDeleted: { $ne: true } }), postIds),
        countOnPosts(SavedPost, onPosts(previous), postIds),
        canCompareShares(window)
            ? countOnPosts(PostInteraction, onPosts(previous, { interactionType: "share" }), postIds)
            : null,
        Post.countDocuments({ ...ownPosts, createdAt: previous })
    ]);

    return {
        previousFrom: window.previousStart.toISOString(),
        previousTo: window.previousEnd.toISOString(),
        metrics: {
            newFollowers: comparisonMetric(summary.newFollowers, newFollowers),
            likes: comparisonMetric(summary.likes, likes),
            comments: comparisonMetric(summary.comments, comments),
            saves: comparisonMetric(summary.saves, saves),
            shares: shares === null ? null : comparisonMetric(summary.shares, shares),
            postsPublished: comparisonMetric(summary.postsPublished, postsPublished)
        }
    };
};

const loadBundle = async (user, tier, days) => {
    const key = cacheKey(user._id, days, tier);
    const cached = await readCache(key);
    if (cached) return cached;

    const bundle = await buildInsights(user, tier, days);
    await writeCache(key, bundle);
    return bundle;
};

const buildTierRestrictedError = (tier, requiredTier, feature) =>
    // `errors` is an OBJECT on purpose. The app's HTTP client treats a 403 whose
    // `errors` is a LIST as the legal re-acceptance gate.
    new ApiError(403, `${feature} is available on the ${TIER_NAMES[requiredTier]} plan.`, {
        errorCode: "INSIGHTS_TIER_RESTRICTED",
        subscriptionTier: tier,
        requiresUpgrade: true,
        requiredTier,
        availablePlans: PAID_TIERS.filter((plan) => tierAtLeast(plan, requiredTier))
    });

const prepareRequest = async (req, restriction) => {
    const user = req.user;
    if (!user?.isBusinessProfile || !user?.businessProfileId) {
        throw new ApiError(403, "Insights are available for business accounts", {
            errorCode: "INSIGHTS_BUSINESS_ONLY"
        });
    }

    const tier = await resolvePlanTier(user._id);
    if (restriction && !tierAtLeast(tier, restriction.requiredTier)) {
        throw buildTierRestrictedError(tier, restriction.requiredTier, restriction.feature);
    }

    const days = resolveRange(req.query.range, PLAN_LIMITS[tier].insightsMaxDays);
    return { user, tier, days };
};

// GET /api/v1/business/insights?range=7|30|90
export const getBusinessInsights = asyncHandler(async (req, res) => {
    const { user, tier, days } = await prepareRequest(req);
    const { payload } = await loadBundle(user, tier, days);

    return res.status(200).json(new ApiResponse(200, payload, "Insights fetched successfully"));
});

// GET /api/v1/business/insights/posts?range=&page=&limit=&sort=   (Corporate)
export const getBusinessInsightsPosts = asyncHandler(async (req, res) => {
    const { user, tier, days } = await prepareRequest(req, { requiredTier: "corporate", feature: "The full post list" });
    const { payload, rows } = await loadBundle(user, tier, days);

    const sort = resolveSort(req.query.sort);
    const { page, limit } = parsePaging(req.query);
    const { items, total, totalPages } = paginate(sortRows(rows, sort), page, limit);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                tier,
                rangeApplied: days,
                generatedAt: payload.generatedAt,
                sort,
                page,
                limit,
                total,
                totalPages,
                posts: items
            },
            "Insights posts fetched successfully"
        )
    );
});

// GET /api/v1/business/insights/export?range=7|30|90   (Corporate)
export const exportBusinessInsights = asyncHandler(async (req, res) => {
    const { user, tier, days } = await prepareRequest(req, { requiredTier: "corporate", feature: "Insights export" });
    const bundle = await loadBundle(user, tier, days);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="findernate-insights-${days}d-${istDayKey(new Date())}.csv"`
    );

    return res.status(200).send(buildInsightsCsv(bundle));
});
