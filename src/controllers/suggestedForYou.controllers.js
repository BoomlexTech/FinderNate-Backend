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

    // Same eligibility rules the personalised path applies at its own final
    // lookup — active, not a business profile, not blocked.
    const eligible = await User.find({
        // excludeIds: for a signed-in caller, themself, who they already follow
        // and who they dismissed (#5).
        _id: { $in: rankedIds, $nin: [...blockedUsers, ...excludeIds] },
        accountStatus: 'active',
        isBusinessProfile: { $ne: true },
    }).select('username fullName profileImageUrl bio isBusinessProfile');

    // Re-impose the popularity order: $in returns documents in natural order,
    // not the order of the array handed to it.
    eligible.sort((a, b) =>
        (countById.get(b._id.toString()) || 0) - (countById.get(a._id.toString()) || 0));

    const pageUsers = eligible.slice(skip, skip + limit);

    const followingCounts = await Follower.aggregate([
        { $match: { followerId: { $in: pageUsers.map(u => u._id) } } },
        { $group: { _id: "$followerId", count: { $sum: 1 } } },
    ]);
    const followingMap = new Map(followingCounts.map(f => [f._id.toString(), f.count]));

    const details = pageUsers.map(user => ({
        _id: user._id,
        username: user.username,
        fullName: user.fullName,
        profileImageUrl: user.profileImageUrl,
        bio: user.bio,
        isBusinessProfile: user.isBusinessProfile,
        followersCount: countById.get(user._id.toString()) || 0,
        followingCount: followingMap.get(user._id.toString()) || 0,
        // Nobody is signed in, so nobody is followed by them.
        isFollowing: false,
    }));

    const withBadges = await addBadgesToUsers(details);

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

        // Nothing personal to suggest yet (a new account with no likes,
        // comments or follows): fall back to popular accounts rather than an
        // empty row, minus everyone they already follow or dismissed.
        if (suggestionMap.size === 0) {
            return sendPopularSuggestions(req, res, {
                excludeIds: [
                    new mongoose.Types.ObjectId(currentUserId),
                    ...followingIds,
                    ...dismissedIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)),
                ],
            });
        }

        // Sort by score, then paginate, then shuffle the page batch
        let suggestions = Array.from(suggestionMap.values()).sort((a, b) => b.score - a.score);
        const paginated = suggestions.slice(skip, skip + limit);
        shuffleArray(paginated);

        const userIds = paginated.map(s => s.userId);

        // Fetch users with selected fields (excluding blocked users)
        const users = await User.find({
            _id: {
                $in: userIds,
                $ne: currentUserId,
                $nin: blockedUsers
            },
            accountStatus: 'active',
            isBusinessProfile: { $ne: true }
        }).select('username fullName profileImageUrl bio isBusinessProfile');

        // Get follower/following counts
        const [followersCounts, followingCounts] = await Promise.all([
            Follower.aggregate([
                { $match: { userId: { $in: userIds } } },
                { $group: { _id: "$userId", count: { $sum: 1 } } }
            ]),
            Follower.aggregate([
                { $match: { followerId: { $in: userIds } } },
                { $group: { _id: "$followerId", count: { $sum: 1 } } }
            ])
        ]);

        const followersMap = new Map(followersCounts.map(f => [f._id.toString(), f.count]));
        const followingMap = new Map(followingCounts.map(f => [f._id.toString(), f.count]));

        // Final mapping
        const suggestionsWithDetails = paginated.map(suggestion => {
            const user = users.find(u => u._id.toString() === suggestion.userId.toString());
            if (!user) return null;

            return {
                _id: user._id,
                username: user.username,
                fullName: user.fullName,
                profileImageUrl: user.profileImageUrl,
                bio: user.bio,
                isBusinessProfile: user.isBusinessProfile,
                followersCount: followersMap.get(user._id.toString()) || 0,
                followingCount: followingMap.get(user._id.toString()) || 0,
                isFollowing: false // All suggested users are not followed by design
            };
        }).filter(Boolean);
        
        // Add subscription badges to suggested users
        const suggestionsWithBadges = await addBadgesToUsers(suggestionsWithDetails);

        // Final response
        return res.status(200).json(
            new ApiResponse(200, {
                suggestions: suggestionsWithBadges,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(suggestionMap.size / limit),
                    totalSuggestions: suggestionMap.size,
                    hasNextPage: skip + limit < suggestionMap.size,
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
