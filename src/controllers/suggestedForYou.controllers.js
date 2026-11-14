import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/user.models.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Like from "../models/like.models.js";
import Comment from "../models/comment.models.js";
import Follower from "../models/follower.models.js";
import mongoose from "mongoose";
import { addBadgesToUsers } from "../utils/userBadge.utils.js";
import { redisClient } from "../config/redis.config.js";
import Business from "../models/business.models.js";
import Post from "../models/userPost.models.js";

/* ------------------------- dismissed suggestions (#5) ------------------------ */

// "✕" on a suggestion card hides that account from the caller's suggestions
// for 30 days (Phase 2 #5). Redis with a TTL rather than a field on User: the
// list is per-viewer, short-lived and must never grow without bound.
const DISMISS_TTL_SECONDS = 30 * 24 * 60 * 60;
const dismissedKey = (userId) => `fn:suggest:dismissed:${userId}`;

const getDismissedIds = async (userId) => {
    try {
        return await redisClient.smembers(dismissedKey(userId));
    } catch (err) {
        // A Redis hiccup must not empty the panel; show everything instead.
        console.error("getDismissedIds failed:", err.message);
        return [];
    }
};

// Constants for scoring
const LIKE_SCORE = 3;
const COMMENT_SCORE = 2;
const MUTUAL_SCORE = 1;

// Helper: Shuffle array
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// The signed-out ranking is the same for every visitor, so it is computed once
// and reused.
//
// The aggregation below has no $match in front of its $group, so MongoDB has to
// read every document in the Follower collection and build the whole group
// before $sort/$limit can apply. It sat uncached and unrated behind an
// optionalVerifyJWT route on the most-hit public page: every logged-out visitor
// — or one scripted loop against the public URL — triggered a full collection
// scan, and the connection pool it saturates is the same one checkout, chat and
// signed-in feeds use. A short TTL keeps "most followed" fresh enough for a
// discovery panel while collapsing a burst of anonymous traffic into one scan.
const POPULAR_RANKING_TTL_MS = 5 * 60 * 1000;
const _popularRanking = { data: null, expiry: 0 };

const getPopularRanking = async () => {
    if (_popularRanking.data && Date.now() < _popularRanking.expiry) {
        return _popularRanking.data;
    }

    const ranked = await Follower.aggregate([
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 200 },
    ]);

    _popularRanking.data = ranked;
    _popularRanking.expiry = Date.now() + POPULAR_RANKING_TTL_MS;
    return ranked;
};

// Accounts that posted recently: the last resort when nobody has followers
// yet (a young platform), so the "Follow suggestions" strip is never empty.
const RECENT_POSTERS_TTL_MS = 5 * 60 * 1000;
const _recentPosters = { data: null, expiry: 0 };
const getRecentPosters = async () => {
    if (_recentPosters.data && Date.now() < _recentPosters.expiry) return _recentPosters.data;
    const rows = await Post.aggregate([
        { $sort: { createdAt: -1 } },
        { $limit: 1000 },
        { $group: { _id: "$userId", last: { $max: "$createdAt" } } },
        { $sort: { last: -1 } },
        { $limit: 200 },
    ]);
    _recentPosters.data = rows.map((r) => r._id).filter(Boolean);
    _recentPosters.expiry = Date.now() + RECENT_POSTERS_TTL_MS;
    return _recentPosters.data;
};

/**
 * The accounts out of `ids` that may be suggested, in the same order: active,
 * not blocked or excluded, and — for businesses — not hidden by the KYC rules
 * (#87). Business accounts used to be left out entirely, and since most
 * active accounts are businesses the strip on the home feed came back empty
 * (client feedback: "Follow suggestions not completed").
 */
const eligibleInOrder = async (ids, excludeIds = []) => {
    const exclude = new Set(excludeIds.map(String));
    const wanted = [];
    const seen = new Set();
    for (const id of ids) {
        const key = String(id);
        if (!mongoose.isValidObjectId(key) || exclude.has(key) || seen.has(key)) continue;
        seen.add(key);
        wanted.push(new mongoose.Types.ObjectId(key));
    }
    if (wanted.length === 0) return [];
    const users = await User.find({ _id: { $in: wanted }, accountStatus: 'active' })
        .select('username fullName profileImageUrl bio isBusinessProfile');
    const businessIds = users.filter((u) => u.isBusinessProfile).map((u) => u._id);
    const hidden = businessIds.length
        ? new Set((await Business.find({ userId: { $in: businessIds }, visibilityTier: 'hidden' }).select('userId').lean()).map((b) => String(b.userId)))
        : new Set();
    const byId = new Map(users.filter((u) => !hidden.has(String(u._id))).map((u) => [String(u._id), u]));
    return wanted.map((id) => byId.get(String(id))).filter(Boolean);
};

/** Follower / following counts and badges for one page of users. */
const describeUsers = async (pageUsers, reasons = new Map()) => {
    const ids = pageUsers.map((u) => u._id);
    const [followersCounts, followingCounts] = await Promise.all([
        Follower.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: "$userId", count: { $sum: 1 } } }]),
        Follower.aggregate([{ $match: { followerId: { $in: ids } } }, { $group: { _id: "$followerId", count: { $sum: 1 } } }]),
    ]);
    const followersMap = new Map(followersCounts.map((f) => [f._id.toString(), f.count]));
    const followingMap = new Map(followingCounts.map((f) => [f._id.toString(), f.count]));
    const details = pageUsers.map((user) => ({
        _id: user._id,
        username: user.username,
        fullName: user.fullName,
        profileImageUrl: user.profileImageUrl,
        bio: user.bio,
        isBusinessProfile: user.isBusinessProfile,
        followersCount: followersMap.get(user._id.toString()) || 0,
        followingCount: followingMap.get(user._id.toString()) || 0,
        isFollowing: false,
        reason: reasons.get(user._id.toString()) || null,
    }));
    return addBadgesToUsers(details);
};

/**
 * Signed-out visitors get the accounts most people follow.
 *
 * Everything the personalised path below scores on — posts you liked, posts you
 * commented on, friends you have in common — requires knowing who you are.
 * There is nothing to personalise for a visitor, but "nothing to personalise"
 * is not the same as "nothing to show": this panel is how someone who has just
 * arrived finds the first account worth following.
 *
 * Same response shape as the personalised path, so the client needs no branch.
 */
const sendPopularSuggestions = async (req, res, { excludeIds = [] } = {}) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;
    const blockedUsers = req.blockedUsers || [];

    // Follower counts are not denormalised onto User, so ranking by popularity
    // means aggregating. Capped well above one page: the sort has to happen
    // before the cut or "most followed" would mean "most followed out of an
    // arbitrary slice". Cached — see getPopularRanking above.
    const ranked = await getPopularRanking();

    const rankedIds = ranked.map(r => r._id);
    const countById = new Map(ranked.map(r => [r._id.toString(), r.count]));

    // Most followed first, then accounts that posted recently, so a young
    // platform with few follows still has someone to suggest. excludeIds: for
    // a signed-in caller, themself, who they already follow and who they
    // dismissed (#5).
    const recent = await getRecentPosters();
    const eligible = await eligibleInOrder(
        [...rankedIds, ...recent],
        [...blockedUsers, ...excludeIds],
    );

    const pageUsers = eligible.slice(skip, skip + limit);
    const reasons = new Map(pageUsers.map((u) => [u._id.toString(), countById.has(u._id.toString()) ? 'Popular on Findernate' : 'New on Findernate']));
    const withBadges = await describeUsers(pageUsers, reasons);

    return res.status(200).json(
        new ApiResponse(200, {
            suggestions: withBadges,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(eligible.length / limit),
                totalSuggestions: eligible.length,
                hasNextPage: skip + limit < eligible.length,
                hasPrevPage: page > 1,
            },
        }, "Popular users retrieved successfully")
    );
};

const getSuggestedForYou = asyncHandler(async (req, res) => {
    // The route is mounted with optionalVerifyJWT, so req.user is legitimately
    // undefined for a signed-out visitor — and destructuring it threw
    // "Cannot destructure property '_id' of 'req.user' as it is undefined",
    // which asyncHandler turned into a 500. Every logged-out visitor to the
    // home page hit it, so the panel had never worked for anyone not signed in.
    if (!req.user?._id) {
        return sendPopularSuggestions(req, res);
    }

    const { _id: currentUserId } = req.user;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    // Get blocked users from middleware
    const blockedUsers = req.blockedUsers || [];

    try {
        // 1. Users whose posts the current user liked
        const likedUsers = await Like.aggregate([
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(currentUserId),
                    postId: { $exists: true }
                }
            },
            {
                $lookup: {
                    from: "posts",
                    localField: "postId",
                    foreignField: "_id",
                    pipeline: [{ $project: { userId: 1 } }],
                    as: "post"
                }
            },
            { $unwind: "$post" },
            {
                $group: {
                    _id: "$post.userId",
                    likeCount: { $sum: 1 }
                }
            },
            { $sort: { likeCount: -1 } },
            { $limit: 30 }
        ]);

        // 2. Users whose posts the current user commented on
        const commentedUsers = await Comment.aggregate([
            {
                $match: {
                    userId: new mongoose.Types.ObjectId(currentUserId)
                }
            },
            {
                $lookup: {
                    from: "posts",
                    localField: "postId",
                    foreignField: "_id",
                    pipeline: [{ $project: { userId: 1 } }],
                    as: "post"
                }
            },
            { $unwind: "$post" },
            {
                $group: {
                    _id: "$post.userId",
                    commentCount: { $sum: 1 }
                }
            },
            { $sort: { commentCount: -1 } },
            { $limit: 30 }
        ]);

        // 3. Get users that current user is already following (to exclude them)
        const currentUserFollowing = await Follower.find({ followerId: currentUserId }).select('userId');
        const followingIds = currentUserFollowing.map(f => f.userId);
        const followingIdsSet = new Set(followingIds.map(id => id.toString()));

        // 4. Mutual friends

        const mutualFriends = await Follower.aggregate([
            {
                $match: {
                    followerId: { $in: followingIds }
                }
            },
            {
                $group: {
                    _id: "$userId",
                    mutualCount: { $sum: 1 }
                }
            },
            { $sort: { mutualCount: -1 } },
            { $limit: 30 }
        ]);

        // Combine suggestions into map
        const suggestionMap = new Map();

        for (const user of likedUsers) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                suggestionMap.set(user._id.toString(), {
                    userId: user._id,
                    score: user.likeCount * LIKE_SCORE,
                    reason: "You liked their posts"
                });
            }
        }

        for (const user of commentedUsers) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                const existing = suggestionMap.get(user._id.toString());
                if (existing) {
                    existing.score += user.commentCount * COMMENT_SCORE;
                    existing.reason = "You liked and commented on their posts";
                } else {
                    suggestionMap.set(user._id.toString(), {
                        userId: user._id,
                        score: user.commentCount * COMMENT_SCORE,
                        reason: "You commented on their posts"
                    });
                }
            }
        }

        for (const user of mutualFriends) {
            if (user._id.toString() !== currentUserId.toString() && !followingIdsSet.has(user._id.toString())) {
                const existing = suggestionMap.get(user._id.toString());
                if (existing) {
                    existing.score += user.mutualCount * MUTUAL_SCORE;
                    existing.reason += " and you have mutual friends";
                } else {
                    suggestionMap.set(user._id.toString(), {
                        userId: user._id,
                        score: user.mutualCount * MUTUAL_SCORE,
                        reason: "You have mutual friends"
                    });
                }
            }
        }

        // Accounts the caller dismissed with "✕" stay out for 30 days (#5).
        const dismissedIds = await getDismissedIds(currentUserId);
        for (const id of dismissedIds) suggestionMap.delete(id);

        // Ranked personal picks first (likes, comments, mutual friends), then
        // popular accounts and recent posters to fill the row. Before, the
        // personal picks were filtered down to non-business accounts with no
        // top-up, which usually left nothing at all.
        const personal = Array.from(suggestionMap.values()).sort((a, b) => b.score - a.score);
        const reasons = new Map(personal.map((sug) => [sug.userId.toString(), sug.reason]));
        const exclude = [
            String(currentUserId),
            ...followingIds.map(String),
            ...dismissedIds,
            ...blockedUsers.map(String),
        ];
        const [ranked, recent] = await Promise.all([getPopularRanking(), getRecentPosters()]);
        for (const r of ranked) if (!reasons.has(r._id.toString())) reasons.set(r._id.toString(), 'Popular on Findernate');
        const eligible = await eligibleInOrder(
            [...personal.map((sug) => sug.userId), ...ranked.map((r) => r._id), ...recent],
            exclude,
        );

        const pageUsers = eligible.slice(skip, skip + limit);
        for (const u of pageUsers) if (!reasons.has(u._id.toString())) reasons.set(u._id.toString(), 'New on Findernate');
        const suggestionsWithBadges = await describeUsers(pageUsers, reasons);

        return res.status(200).json(
            new ApiResponse(200, {
                suggestions: suggestionsWithBadges,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(eligible.length / limit),
                    totalSuggestions: eligible.length,
                    hasNextPage: skip + limit < eligible.length,
                    hasPrevPage: page > 1
                }
            }, "Suggested for you users retrieved successfully")
        );

    } catch (error) {
        console.error("Suggested Users Error:", error);
        throw new ApiError(500, "Error fetching suggested for you users");
    }
});

/**
 * POST /api/v1/suggestions/dismiss   body: { userId }
 * Hides one account from the caller's "Suggested for you" for 30 days (#5).
 */
const dismissSuggestion = asyncHandler(async (req, res) => {
    const currentUserId = req.user?._id;
    const { userId } = req.body || {};
    if (!currentUserId) throw new ApiError(401, "Sign in to manage suggestions");
    if (!userId || !mongoose.isValidObjectId(userId)) throw new ApiError(400, "A valid userId is required");

    try {
        await redisClient
            .multi()
            .sadd(dismissedKey(currentUserId), String(userId))
            .expire(dismissedKey(currentUserId), DISMISS_TTL_SECONDS)
            .exec();
    } catch (err) {
        console.error("dismissSuggestion failed:", err.message);
        throw new ApiError(503, "Could not save that right now, please try again");
    }

    return res.status(200).json(new ApiResponse(200, { userId, dismissed: true }, "Suggestion dismissed"));
});

export {
    getSuggestedForYou,
    dismissSuggestion
};
