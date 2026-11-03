import { getFeedSignals, rankTimeExpression, excludedObjectIds } from '../utils/feedSignals.utils.js';
import { asyncHandler } from "../utils/asyncHandler.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";
import Follower from "../models/follower.models.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { getViewableUserIds } from "../middlewares/privacy.middleware.js";
import { enrichWithRatings } from "../utils/reviewUtils.js";
import { addBadgesToNestedUsers } from "../utils/userBadge.utils.js";
import { getLikedByPreview } from "../utils/likedByPreview.utils.js";
import Like from "../models/like.models.js";
import { batchIsLikedByUser, batchGetLikedByUsers, batchGetLikesCount, batchGetCommentsCount, batchSharedCount } from "../utils/postEngagement.utils.js";
import mongoose from "mongoose";
import { getFollowStatus } from "../utils/followEngagement.utils.js";
import { REEL_MAX_DURATION_SECONDS } from "../constants/uploadLimits.js";


// Simple in-memory cache
const cache = {
    reels: {
        data: null,
        timestamp: null,
        cacheKey: null,
        expiry: 5 * 60 * 1000 // 5 minutes
    }
};

// Unified function to get reels with comprehensive data and filtering
export const getSuggestedReels = asyncHandler(async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            contentType,
            postType,
            sortBy = 'latest',
            location,
            tag,
            suggested = false
        } = req.query;

        // The viewer is whoever the token says, and nothing else.
        //
        // This used to fall back to `req.query.userId` when there was no token,
        // and the route is optionalVerifyJWT — so an anonymous caller could name
        // any user id and be answered AS that user: the private accounts that
        // user follows were added to the allow-list below, and their like
        // history came back in isLikedBy. A non-ObjectId value also reached
        // `new mongoose.Types.ObjectId(...)` further down and produced a 500.
        //
        // ✅ Handle both Mongoose document and plain object from cache
        const currentUserIdRaw = req.user?._id;
        const currentUserId = currentUserIdRaw ? (typeof currentUserIdRaw === 'string' ? currentUserIdRaw : currentUserIdRaw.toString()) : null;

        // ✅ FIXED: Convert blocked user IDs to ObjectIds for MongoDB aggregation
        const blockedUsersRaw = req.blockedUsers || [];
        const blockedUsers = blockedUsersRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );

        const pageNum = Number(page);
        const limitNum = Number(limit);
        const skip = (pageNum - 1) * limitNum;


        // ✅ REELS DISCOVERY FEED LOGIC
        // For reels (discovery feed like Instagram/TikTok), we want to show reels from ALL users
        // Not just from people you follow - this is different from the home feed

        // Get ALL public active users (exclude banned/deleted)
        //
        // `privacy` and `isFullPrivate` are two SEPARATE schema fields, and the
        // rest of the codebase treats an account as private when EITHER is set
        // (share.controllers.js:33, post/read.controllers.js, story.controllers.js,
        // privacy.middleware.js). This query looked at `privacy` alone, so an
        // account with isFullPrivate:true and a stale privacy:'public' — exactly
        // the combination the privacy middleware's own comment says exists — had
        // its reels served to the entire platform, anonymous callers included.
        const publicUsers = await User.find({
            accountStatus: 'active',
            isDeleted: { $ne: true },
            isFullPrivate: { $ne: true },
            $or: [
                { privacy: 'public' },
                { privacy: { $exists: false } },
                { privacy: null }
            ]
        }).select('_id').lean();
        const publicUserIds = publicUsers.map(u =>
            typeof u._id === 'string' ? new mongoose.Types.ObjectId(u._id) : u._id
        );


        // Get private users that the viewer follows (to include their private reels)
        let allowedUserIds = [...publicUserIds];

        if (currentUserId) {
            const following = await Follower.find({ followerId: currentUserId }).select('userId').lean();
            const followingIds = following.map(f => f.userId);

            // Get which of the followed users have private accounts (active only)
            const privateFollowedUsers = await User.find({
                _id: { $in: followingIds },
                privacy: 'private',
                accountStatus: 'active',
                isDeleted: { $ne: true }
            }).select('_id').lean();

            const privateFollowedUserIds = privateFollowedUsers.map(u =>
                typeof u._id === 'string' ? new mongoose.Types.ObjectId(u._id) : u._id
            );


            // Add private followed users to the allowed list
            allowedUserIds = [...allowedUserIds, ...privateFollowedUserIds];
        }


        // Build match criteria for reels discovery feed
        // Show reels from: ALL public users + private users that viewer follows
        // Exclude blocked users and private posts
        const matchCriteria = {
            status: { $in: ["published", "scheduled"] },
            userId: { $in: allowedUserIds, $nin: blockedUsers },
            "settings.privacy": { $ne: "private" }  // Exclude posts marked as private
        };

        // Filter by postType if specified (reel, photo, video, story)
        if (postType) {
            matchCriteria.postType = postType;
        } else {
            // Default to reels and videos for better reel experience
            matchCriteria.postType = { $in: ["reel", "video"] };
        }

        // Vibes is a swipe-up scroller, so only short clips belong in it — a
        // five-minute video still posts and still shows in the feed, it just
        // does not land here.
        //
        // Duration is populated by the Bunny Stream webhook once encoding
        // finishes. Posts from before Stream have no duration at all, and
        // excluding those would empty the existing feed, so an unset duration
        // is treated as eligible rather than assumed to be long.
        matchCriteria.media = {
            $not: {
                $elemMatch: {
                    type: "video",
                    duration: { $gt: REEL_MAX_DURATION_SECONDS }
                }
            }
        };

        // A reel still encoding is shown to its author and nobody else. Bunny
        // needs a minute or two before anything plays, and until then everyone
        // else would swipe onto a reel that cannot start. The author still sees
        // it, with encoding progress, so their post has not simply disappeared.
        matchCriteria.$and = [
            ...(matchCriteria.$and || []),
            {
                $or: [
                    ...(currentUserId ? [{ userId: new mongoose.Types.ObjectId(currentUserId) }] : []),
                    { media: { $not: { $elemMatch: { type: "video", processing: true } } } }
                ]
            }
        ];

        // Filter by contentType if specified (normal, product, business)
        if (contentType) {
            matchCriteria.contentType = contentType;
        }

        // Filter by location if specified
        if (location) {
            matchCriteria.$or = [
                { "location": { $regex: location, $options: "i" } },
                { "customization.normal.location.name": { $regex: location, $options: "i" } },
                { "customization.product.location.name": { $regex: location, $options: "i" } },
                { "customization.business.location.city": { $regex: location, $options: "i" } }
            ];
        }

        // Filter by tag if specified.
        // $in: [tag] was an exact, case-SENSITIVE match that never stripped a
        // leading '#', so the "#Coffee" a user copies off a post card missed the
        // stored tag "coffee" every time. Service tags were missing too.
        if (tag) {
            const tagTerm = String(tag)
                .replace(/^#+/, '')
                .trim()
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tagRegex = new RegExp(`^${tagTerm}$`, 'i');
            matchCriteria.$or = [
                ...(matchCriteria.$or || []),
                { "hashtags": tagRegex },
                { "customization.normal.tags": tagRegex },
                { "customization.product.tags": tagRegex },
                { "customization.service.tags": tagRegex },
                { "customization.business.tags": tagRegex }
            ];
        }

        // Not interested / hidden vibes are left out, and the newest-first order
        // takes the viewer's preferences into account (Phase 2 #26, #68).
        const feedSignals = currentUserId ? await getFeedSignals(currentUserId) : null;
        const excludedPostIds = excludedObjectIds(feedSignals);
        if (excludedPostIds.length) matchCriteria._id = { $nin: excludedPostIds };
        const rankTime = (!sortBy || sortBy === 'latest') ? rankTimeExpression(feedSignals) : null;

        // Build sort criteria
        let sortCriteria = {};
        switch (sortBy) {
            case 'popular':
                sortCriteria = { "engagement.likes": -1, "engagement.views": -1, createdAt: -1 };
                break;
            case 'trending':
                sortCriteria = { "engagement.shares": -1, "engagement.comments": -1, createdAt: -1 };
                break;
            case 'oldest':
                sortCriteria = { createdAt: 1 };
                break;
            case 'latest':
            default:
                sortCriteria = { createdAt: -1, _id: -1 };
                break;
        }

        // Check cache first — isLikedBy is never stored in cache, always recomputed
        const cacheKey = `${pageNum}_${limitNum}_${currentUserId || 'anonymous'}_${postType || 'all'}_${contentType || 'all'}_${sortBy}_${location || ''}_${tag || ''}_${suggested}`;
        if (cache.reels.data &&
            cache.reels.timestamp &&
            cache.reels.cacheKey === cacheKey &&
            (Date.now() - cache.reels.timestamp < cache.reels.expiry)) {

            const cachedData = cache.reels.data;
            if (currentUserId && cachedData.reels?.length) {
                const reelIds = cachedData.reels.map(r => r._id);
                const [likedSet, likeCountMap, commentCountMap, likedByUsersMap, sharedCountMap] = await Promise.all([
                    batchIsLikedByUser(currentUserId, reelIds),
                    batchGetLikesCount(cachedData.reels),
                    batchGetCommentsCount(cachedData.reels),
                    batchGetLikedByUsers(reelIds),
                    batchSharedCount(cachedData.reels)
                ]);
                const userIdStr = currentUserId.toString();
                const updatedReels = cachedData.reels.map(r => {
                    const rid = r._id.toString();
                    let likedByUsers = likedByUsersMap.get(rid) || [];
                    // Inject viewer if their like is deferred in the cache
                    if (likedSet.has(rid) && !likedByUsers.find(u => (u.userId || u._id?.toString()) === userIdStr)) {
                        likedByUsers = [{ _id: userIdStr, userId: userIdStr, username: req.user?.username, fullName: req.user?.fullName, profileImageUrl: req.user?.profileImageUrl }, ...likedByUsers];
                    }
                    const preview = getLikedByPreview(likedByUsers, currentUserId);
                    return {
                        ...r,
                        engagement: { ...(r.engagement || {}), likes: likeCountMap.get(rid) ?? r.engagement?.likes ?? 0, comments: commentCountMap.get(rid) ?? r.engagement?.comments ?? 0, shares: sharedCountMap.get(rid) ?? r.engagement?.shares ?? 0 },
                        isLikedBy: likedSet.has(rid),
                        likedBy: likedByUsers,
                        likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
                    };
                });
                return res.status(200).json(new ApiResponse(200, { ...cachedData, reels: updatedReels }, "Reels fetched from cache"));
            }
            return res.status(200).json(new ApiResponse(200, cachedData, "Reels fetched from cache"));
        }

        // Build aggregation pipeline for comprehensive data
        const pipeline = [
            // Match criteria
            { $match: matchCriteria },

            ...(rankTime ? [{ $addFields: { rankTime } }] : []),

            // Sort by specified criteria
            { $sort: rankTime ? { rankTime: -1, ...sortCriteria } : sortCriteria },

            // Add pagination
            { $skip: skip },
            { $limit: limitNum },



            // Add computed fields and enhance with Bunny.net details
            {
                $addFields: {
                    isLikedBy: false,
                    isFollowing: false,

                    // Enhanced media with Bunny.net details
                    media: {
                        $map: {
                            input: "$media",
                            as: "mediaItem",
                            in: {
                                $mergeObjects: [
                                    "$$mediaItem",
                                    {
                                        // Add Bunny.net metadata
                                        bunnyId: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $let: {
                                                        vars: {
                                                            filename: { $arrayElemAt: ["$$urlParts", -1] }
                                                        },
                                                        in: { $arrayElemAt: [{ $split: ["$$filename", "."] }, 0] }
                                                    }
                                                }
                                            }
                                        },
                                        bunnyFolder: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $arrayElemAt: ["$$urlParts", -2]
                                                }
                                            }
                                        },
                                        isBunnyHosted: {
                                            $regexMatch: {
                                                input: { $ifNull: ["$$mediaItem.url", ""] },
                                                regex: "b-cdn.net"
                                            }
                                        },
                                        quality: { $ifNull: ["$$mediaItem.quality", "auto"] },
                                        publicId: {
                                            $let: {
                                                vars: {
                                                    urlParts: { $split: ["$$mediaItem.url", "/"] }
                                                },
                                                in: {
                                                    $let: {
                                                        vars: {
                                                            filename: { $arrayElemAt: ["$$urlParts", -1] },
                                                            folder: { $arrayElemAt: ["$$urlParts", -2] }
                                                        },
                                                        in: {
                                                            $concat: [
                                                                "$$folder",
                                                                "/",
                                                                { $arrayElemAt: [{ $split: ["$$filename", "."] }, 0] }
                                                            ]
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        ];

        // Add user-specific isFollowed via aggregation (isLikedBy handled via Redis below)
        if (currentUserId) {
            const currentUserObjectId = new mongoose.Types.ObjectId(currentUserId);

            pipeline.push({
                $lookup: {
                    from: "followings",
                    let: { postUserId: "$userId", currentUserId: currentUserObjectId },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$userId", "$$currentUserId"] },
                                        { $eq: ["$followingId", "$$postUserId"] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: "userFollow"
                }
            });

            pipeline.push({
                $addFields: {
                    isFollowed: { $gt: [{ $size: "$userFollow" }, 0] }
                }
            });

            pipeline.push({ $project: { userFollow: 0 } });
        }

        // Remove analytics field from all responses
        pipeline.push({
            $project: {
                analytics: 0
            }
        });

        // console.log('🎬 Reels Debug - Match criteria:', JSON.stringify(matchCriteria, null, 2));

        // Execute aggregation
        let reels = await Post.aggregate(pipeline);

        // console.log('🎬 Reels Debug - Reels found:', reels.length);

        // ✅ NOTE: Business payment plan filtering does NOT apply to reels
        // Business accounts can post reels freely without needing a paid plan
        // The payment plan filter ONLY applies to posts and ads

        if (reels.length === 0) {
            // Debug: Check if there are ANY reels in the database
            const totalReelsInDB = await Post.countDocuments({ postType: { $in: ["reel", "video"] } });
            const publishedReels = await Post.countDocuments({ postType: { $in: ["reel", "video"] }, status: "published" });
            // console.log('⚠️ No reels found. Debug info:');
            // console.log('   - Total reels in DB:', totalReelsInDB);
            // console.log('   - Published reels in DB:', publishedReels);
            // console.log('   - Allowed users count:', allowedUserIds.length);
            // console.log('   - Blocked users count:', blockedUsers.length);
        }

        // Fetch user details using User model
        if (reels.length > 0) {
            // Get unique user IDs from reels
            const userIds = [...new Set(reels.map(reel => reel.userId))];

            // Fetch user details for all unique user IDs
            const users = await User.find(
                { _id: { $in: userIds } },
                { _id: 1, username: 1, fullName: 1, profileImageUrl: 1 }
            );

            // Create a map for quick user lookup
            const userMap = {};
            users.forEach(user => {
                userMap[user._id.toString()] = user;
            });

            // Add user details to each reel
            reels.forEach(reel => {
                const user = userMap[reel.userId?.toString()];
                if (user) {
                    reel.userId = {
                        _id: user._id,
                        username: user.username,
                        fullName: user.fullName
                    };
                    reel.profileImageUrl = user.profileImageUrl;
                } else {
                    // If user not found, set default structure
                    reel.userId = {
                        _id: reel.userId,
                        username: null,
                        fullName: null
                    };
                    reel.profileImageUrl = null;
                }
            });

            // Enrich reels with review/rating data
            reels = await enrichWithRatings(reels, 'userId');

            // Add subscription badges to reel authors
            reels = await addBadgesToNestedUsers(reels);

            // Get likedBy from Redis Hash (max 20 per reel) + isLikedBy status
            const reelIds = reels.map(reel => reel._id);
            const [likedReelSet, likesByReel, reelLikeCountMap, commentCountMap, sharedCountMap] = await Promise.all([
                currentUserId ? batchIsLikedByUser(currentUserId, reelIds) : Promise.resolve(new Set()),
                batchGetLikedByUsers(reelIds),
                batchGetLikesCount(reels),
                batchGetCommentsCount(reels),
                batchSharedCount(reels)
            ]);

            // Inject current user into likedBy if their like is deferred
            if (currentUserId) {
                const userIdStr = currentUserId.toString();
                for (const [idStr, users] of likesByReel) {
                    if (likedReelSet.has(idStr) && !users.find(u => (u.userId || u._id?.toString()) === userIdStr)) {
                        users.unshift({ _id: userIdStr, userId: userIdStr });
                    }
                }
            }

            reels = reels.map(reel => {
                const reelIdStr = reel._id.toString();
                const likedByUsers = likesByReel.get(reelIdStr) || [];
                const preview = getLikedByPreview(likedByUsers, currentUserId);

                return {
                    ...reel,
                    engagement: {
                        ...reel.engagement,
                        likes: reelLikeCountMap.get(reelIdStr) ?? reel.engagement?.likes ?? 0,
                        comments: commentCountMap.get(reelIdStr) ?? reel.engagement?.comments ?? 0,
                        shares: sharedCountMap.get(reelIdStr) ?? reel.engagement?.shares ?? 0,
                    },
                    isLikedBy: likedReelSet.has(reelIdStr),
                    likedBy: likedByUsers,
                    likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
                };
            });

            // Enrich isFollowing from Redis using existing getFollowStatus
            if (currentUserId) {
                await Promise.all(reels.map(async (reel) => {
                    const authorId = reel.userId?._id || reel.userId;
                    if (authorId) {
                        reel.isFollowing = await getFollowStatus(currentUserId, authorId);
                    }
                }));
            }
        }

        // Get total count for pagination
        const totalReels = await Post.countDocuments(matchCriteria);

        const responseData = {
            reels,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: totalReels,
                totalPages: Math.ceil(totalReels / limitNum),
                hasNext: pageNum < Math.ceil(totalReels / limitNum),
                hasPrev: pageNum > 1
            },
            filters: {
                postType: postType || 'all',
                contentType: contentType || 'all',
                sortBy: sortBy,
                location: location || null,
                tag: tag || null,
                suggested: suggested
            },
            metadata: {
                totalResults: totalReels,
                currentQuery: req.query,
                timestamp: new Date().toISOString()
            }
        };

        // Save to cache
        cache.reels.data = responseData;
        cache.reels.timestamp = Date.now();
        cache.reels.cacheKey = cacheKey;

        return res.status(200).json(
            new ApiResponse(200, responseData, "Reels fetched successfully")
        );
    } catch (error) {
        console.error("Error fetching reels:", error);
        return res.status(500).json(
            new ApiResponse(500, {}, "Error fetching reels from database")
        );
    }
});
/**
 * Drop the in-memory vibes page cache. Called when a viewer marks a vibe "Not
 * interested" so the next swipe-load can't serve it again (Phase 2 #68).
 */
export const resetReelsCache = () => {
    cache.reels.data = null;
    cache.reels.timestamp = null;
    cache.reels.cacheKey = null;
};
