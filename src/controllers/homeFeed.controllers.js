import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import Comment from '../models/comment.models.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import Like from '../models/like.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { setCache } from '../middlewares/cache.middleware.js';
import { redisClient, RedisKeys, RedisTTL } from '../config/redis.config.js';
import { getViewableUserIds } from '../middlewares/privacy.middleware.js';
import { bulkCheckActivePaymentPlans } from '../utils/businessPlan.utils.js';
import mongoose from 'mongoose';
import { enrichWithRatings } from '../utils/reviewUtils.js';
import { addBadgesToNestedUsers } from '../utils/userBadge.utils.js';
import { getLikedByPreview } from '../utils/likedByPreview.utils.js';
import { batchIsLikedByUser, batchGetLikedByUsers, batchGetLikesCount, batchGetCommentsCount, batchSharedCount} from '../utils/postEngagement.utils.js';
import { getFollowingIdSet, getPendingFollowRequestIdSet } from '../utils/followEngagement.utils.js';
import {
    feedBoostSlotCount,
    feedRotationSeed,
    getLiveBoosts,
    isCorporateBusinessPlan,
    recordBoostImpressions,
    selectBoostSlots
} from '../utils/boostServing.js';

/**
 * Author id of a feed post, whether userId is still a raw ObjectId (cache path)
 * or has already been $lookup-ed into a populated object.
 */
const feedPostAuthorId = (post) => {
    const author = post?.userId;
    if (!author) return null;
    return (author._id ?? author).toString();
};

/**
 * ✅ HOME FEED - DATE SORTED WITH PAID BUSINESS PRIORITY
 *
 * Sorting Rules:
 * 0. Boosted posts (utils/boostServing.js) take a few slots at the very top, at most
 *    feedBoostSlotCount(limit) of them, Corporate boosts first. A post is only
 *    flagged isPromoted (and counted as an impression) while it holds one of them.
 * 1. Paid business posts (plan2/plan3/plan4) appear at the TOP, Corporate (plan3/plan4)
 *    above Small Business (plan2), each sorted by newest first
 * 2. All other posts appear below, sorted by newest first (date descending)
 * 3. business/product/service CONTENT TYPE posts from unpaid business accounts are
 *    hidden from DISCOVERY only — i.e. from public accounts the viewer does not
 *    follow. The viewer's OWN posts and posts from accounts they follow are always
 *    shown (see the note on `commercialExemptIds` below)
 * 4. Normal content (photos, tweets, videos) from ALL accounts always shows
 * 5. Reels from ALL accounts always show regardless of content type or payment status
 *
 * Payment Plan Criteria:
 * - subscriptionStatus must be 'active'
 * - plan must NOT be 'plan1' (plan1 is free)
 * - Valid paid plans: plan2, plan3, plan4
 */
export const getHomeFeed = asyncHandler(async (req, res) => {
    try {
        // ✅ FIXED: Handle both Mongoose document and plain object from cache
        const userId = req.user?._id ? (typeof req.user._id === 'string' ? req.user._id : req.user._id.toString()) : null;
        // ✅ FIXED: Convert blocked user IDs to ObjectIds for MongoDB aggregation
        const blockedUsersRaw = req.blockedUsers || [];
        const blockedUsers = blockedUsersRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );
        const blockedUserIdSet = new Set(blockedUsersRaw.map(id => id.toString()));
        const page = parseInt(req.query.page, 10) || 1;
        const MAX_LIMIT = 100; // Prevent excessive data requests
        const requestedLimit = parseInt(req.query.limit, 10) || 20;
        const limit = Math.min(requestedLimit, MAX_LIMIT);
        const skip = (page - 1) * limit;


        // Check cache first — isLikedBy is never stored in cache, always computed fresh
        const FEED_CACHE_KEY = RedisKeys.userFeed(userId, page);
        const cachedRaw = await redisClient.get(FEED_CACHE_KEY);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            //* Re-apply blocking to the CACHED page.
            //*
            //* The block itself only clears the blocked-users cache
            //* (blockUser -> invalidateBlockedUsersCache); nothing touches this
            //* viewer's feed key, so for the rest of its TTL the person they had
            //* just blocked kept appearing in their feed — the block looked like
            //* it had not worked, and the only way out was to wait. The live
            //* query below already excludes them; this makes the cache-hit path
            //* agree with it instead of serving a page built before the block.
            const cachedFeed = Array.isArray(cached?.data?.feed) ? cached.data.feed : [];
            const visibleCachedFeed = blockedUserIdSet.size
                ? cachedFeed.filter(post => !blockedUserIdSet.has(feedPostAuthorId(post) || ''))
                : cachedFeed;

            //* A page that emptied out ENTIRELY because of a block is not worth
            //* serving — fall through and rebuild it live so the viewer gets a
            //* full page rather than a blank home screen.
            const cacheStillUsable = visibleCachedFeed.length > 0 || cachedFeed.length === 0;
            if (cacheStillUsable) {
                if (cached?.data) cached.data.feed = visibleCachedFeed;
                if (visibleCachedFeed.length) {
                    const cachedPosts = visibleCachedFeed;
                    const cachedPostIds = cachedPosts.map(p => p._id);
                    const [likedSet, likeCountMap, commentCountMap, likedByUsersMap, sharedCountMap, followingSet, requestedSet] = await Promise.all([
                        userId ? batchIsLikedByUser(userId, cachedPostIds) : Promise.resolve(new Set()),
                        batchGetLikesCount(cachedPosts),
                        // Comments were the one engagement metric NOT resolved live
                        // here, so the feed served the stored engagement.comments —
                        // which nothing maintained and was 0 on every post.
                        batchGetCommentsCount(cachedPosts),
                        batchGetLikedByUsers(cachedPostIds),
                        batchSharedCount(cachedPosts),
                        // Follow state is resolved live for the same reason isLikedBy
                        // is: it is per-viewer and changes the moment they tap Follow,
                        // so a cached value would show a stale "Follow" pill.
                        getFollowingIdSet(userId),
                        getPendingFollowRequestIdSet(userId)
                    ]);

                    cached.data.feed = cachedPosts.map(post => {
                        const idStr = post._id.toString();
                        const likedByUsers = likedByUsersMap.get(idStr) || [];
                        const preview = getLikedByPreview(likedByUsers, userId);
                        const authorId = feedPostAuthorId(post);
                        return {
                            ...post,
                            engagement: {
                                ...post.engagement,
                                likes: likeCountMap.get(idStr) ?? post.engagement?.likes ?? 0,
                                comments: commentCountMap.get(idStr) ?? post.engagement?.comments ?? 0,
                                shares: sharedCountMap.get(idStr) ?? post.engagement?.shares ?? 0
                            },
                            isLikedBy: likedSet.has(idStr),
                            likedBy: likedByUsers,
                            likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
                            isFollowing: !!authorId && followingSet.has(authorId),
                            isFollowRequested: !!authorId && requestedSet.has(authorId),
                        };
                    });

                    // A cached page is still a page somebody looked at.
                    recordBoostImpressions(
                        cachedPosts
                            .filter(post => post.isPromoted === true)
                            .map(post => ({ postId: post._id, authorId: feedPostAuthorId(post) })),
                        userId
                    );
                }
                return res.status(200).json(cached);
            }
        }

        const FEED_LIMIT = 50; // Reduced from 100

        // ✅ 1. Get viewable user IDs based on privacy settings and following relationships
        // For logged-out users (userId is null), this returns only users with public privacy
        // For logged-in users, this returns their following + their own posts + public users
        const viewableUserIdsRaw = await getViewableUserIds(userId);
        // ✅ FIXED: Convert string IDs back to ObjectIds for MongoDB aggregation
        const viewableUserIds = viewableUserIdsRaw.map(id =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );

        // ✅ BUSINESS POST PRIORITY SYSTEM
        // Get business users with active payment plans (plan2, plan3, plan4 - NOT plan1 which is free)
        const activePaymentPlanUserIds = await Business.find({
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId plan').lean();

        // Convert to both ObjectIds and strings for aggregation compatibility
        const activePlanUserIds = activePaymentPlanUserIds.map(b => b.userId);
        const activePlanUserIdsStrings = activePlanUserIds.map(id => id.toString());
        const activePlanUserIdsSet = new Set(activePlanUserIdsStrings);
        // Corporate sits above Small Business inside the paid band, and a boost
        // takes its weight from the author's current plan.
        const paidPlanByUserId = new Map(activePaymentPlanUserIds.map(b => [b.userId.toString(), b.plan]));
        const corporateUserIdsStrings = activePaymentPlanUserIds
            .filter(b => isCorporateBusinessPlan(b.plan))
            .map(b => b.userId.toString());


        // Get all business user IDs
        const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
        const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

        //* Accounts whose commercial posts (product/service/business) are NEVER
        //* hidden by the unpaid-business rule: the viewer themselves and everyone
        //* they follow.
        //*
        //* The rule exists to stop a free business account SELLING through
        //* discovery — businessPlan.utils.js documents it as a discovery-only
        //* filter applied by explore and search. The home feed re-implemented it
        //* inline and applied it to everybody, so a seller's own product post was
        //* missing from their own feed and from their followers' feeds the moment
        //* they were on the free plan. They had published it, it rendered on their
        //* profile, and the feed silently dropped it — which is exactly what the
        //* tester saw. Public strangers still don't get it, so the paid tier keeps
        //* its value.
        //*
        //* Resolved before the aggregation because the pipeline needs the list;
        //* the same Set is reused for the per-post `isFollowing` flag further down
        //* instead of asking Redis for it twice.
        const followingSet = await getFollowingIdSet(userId);
        const commercialExemptIds = [...followingSet];
        if (userId) commercialExemptIds.push(userId.toString());
        const commercialExemptSet = new Set(commercialExemptIds);


        // ✅ 3. OPTIMIZED: Single aggregation query with privacy filtering
        const matchQuery = {
            contentType: { $in: ['normal', 'service', 'product', 'business'] },
            postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
            userId: { $in: viewableUserIds, $nin: blockedUsers },
            // Never show private posts in any public feed
            'settings.privacy': { $ne: 'private' },
            // For logged-out users, only show posts with public visibility
            ...(userId ? {} : {
                $or: [
                    { 'settings.visibility': 'public' },
                    { 'settings.visibility': { $exists: false } }, // Default to public if no setting
                    { 'settings.visibility': null } // Null means public
                ]
            }),
            // A video still encoding is shown to its author and nobody else.
            //
            // Bunny needs a minute or two after upload before anything plays.
            // Until then the post is real but the video is not, so to everyone
            // else it is a broken card in the middle of the feed. The author
            // still sees it, with the encoding progress, so their post does not
            // appear to have vanished.
            //
            // $elemMatch, not a dotted path: a post can carry several media and
            // the type and processing flag must match on the SAME entry, or a
            // photo carousel with one encoding clip would be judged by the
            // wrong element.
            $and: [{
                $or: [
                    ...(userId ? [{ userId: new mongoose.Types.ObjectId(userId) }] : []),
                    { media: { $not: { $elemMatch: { type: 'video', processing: true } } } }
                ]
            }]
        };

        // Boosted posts that fill this page's few boosted slots. Candidates must
        // pass the same visibility rules as everything else in the feed (block
        // list, privacy, followers-only accounts), so the check reuses matchQuery,
        // and must not have been reported since the boost started. They sort
        // above the whole paid band; every other boosted post keeps its ordinary
        // place in that band. Chosen per viewer and per 5 minutes so the slots
        // rotate between boosts, and so the choice is stable across the pages of
        // one browsing session.
        const liveBoosts = await getLiveBoosts(paidPlanByUserId);
        let promotedPostIds = [];
        if (liveBoosts.length > 0) {
            const visibleBoosted = await Post.find({
                ...matchQuery,
                _id: { $in: liveBoosts.map(boost => boost.postId) },
                isReported: { $ne: true }
            }).select('_id').lean();
            const visibleBoostedIds = new Set(visibleBoosted.map(post => post._id.toString()));
            promotedPostIds = selectBoostSlots(
                liveBoosts.filter(boost => visibleBoostedIds.has(boost.postId)),
                feedBoostSlotCount(limit),
                feedRotationSeed(userId)
            ).map(boost => boost.postId);
        }
        const promotedPostIdSet = new Set(promotedPostIds);


        const aggregationPipeline = [
            {
                $match: matchQuery
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userInfo',
                    pipeline: [
                        { $project: { isBusinessProfile: 1 } }
                    ]
                }
            },
            {
                $addFields: {
                    isBusinessAccount: {
                        $cond: [
                            { $gt: [{ $size: '$userInfo' }, 0] },
                            { $arrayElemAt: ['$userInfo.isBusinessProfile', 0] },
                            false
                        ]
                    },
                    // Convert userId to string for comparison
                    userIdString: { $toString: '$userId' }
                }
            },
            {
                // ✅ CRITICAL: Filter out business-type content from unpaid business accounts
                // Rule: Only business/product/service CONTENT TYPE posts from unpaid business accounts are hidden
                // All other posts (normal posts, reels, tweets, videos) from ANY account are always shown
                // Reels are ALWAYS shown regardless of content type or business payment status
                $match: {
                    $expr: {
                        $or: [
                            // Keep ALL posts from users with active paid plans (no need to check isBusinessProfile)
                            { $in: ['$userIdString', activePlanUserIdsStrings] },
                            // Keep ALL posts from non-business accounts
                            { $eq: ['$isBusinessAccount', false] },
                            // Keep ALL posts from the viewer and the accounts they follow —
                            // this is a feed of people they chose, not discovery.
                            { $in: ['$userIdString', commercialExemptIds] },
                            // Keep ALL reels regardless of content type or business status
                            { $eq: ['$postType', 'reel'] },
                            // For unpaid business accounts: only keep normal content type posts
                            {
                                $and: [
                                    { $eq: ['$isBusinessAccount', true] },
                                    { $not: { $in: ['$userIdString', activePlanUserIdsStrings] } },
                                    { $eq: ['$contentType', 'normal'] }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $addFields: {
                    // ✅ SIMPLE PRIORITY: Paid business posts on top, then everything sorted by date
                    // 1 = paid business post (appears on top), 0 = normal post (appears below)
                    // Only checks activePlanUserIdsStrings - no dependency on isBusinessProfile
                    isPaidBusiness: {
                        $cond: [
                            { $in: ['$userIdString', activePlanUserIdsStrings] },
                            1,
                            0
                        ]
                    },
                    // Within the paid band, Corporate above Small Business
                    isCorporate: {
                        $cond: [
                            { $in: ['$userIdString', corporateUserIdsStrings] },
                            1,
                            0
                        ]
                    },
                    // The boosted slots, in the order chosen above: n for the
                    // first, down to 1, and 0 for everything else.
                    ...(promotedPostIds.length > 0 ? {
                        boostRank: {
                            $let: {
                                vars: { slot: { $indexOfArray: [promotedPostIds, { $toString: '$_id' }] } },
                                in: {
                                    $cond: [
                                        { $gte: ['$$slot', 0] },
                                        { $subtract: [promotedPostIds.length, '$$slot'] },
                                        0
                                    ]
                                }
                            }
                        }
                    } : {})
                }
            },
            {
                // Sort: boosted slots, then paid business posts (Corporate first), then by newest date
                $sort: {
                    ...(promotedPostIds.length > 0 ? { boostRank: -1 } : {}),
                    isPaidBusiness: -1,
                    isCorporate: -1,
                    createdAt: -1
                }
            },
            {
                $skip: skip
            },
            {
                $limit: limit
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userId',
                    pipeline: [
                        { $project: { username: 1, profileImageUrl: 1, fullName: 1, isVerified: 1 } }
                    ]
                }
            },
            {
                $unwind: '$userId'
            },
            {
                // Remove temporary fields used for filtering
                $project: {
                    isBusinessAccount: 0,
                    isPaidBusiness: 0,
                    isCorporate: 0,
                    boostRank: 0,
                    userIdString: 0,
                    userInfo: 0
                }
            },
            {
                // Project only necessary fields to reduce payload size
                $project: {
                    _id: 1,
                    userId: 1,
                    contentType: 1,
                    postType: 1,
                    caption: 1,
                    description: 1,
                    media: 1,
                    'settings.privacy': 1,
                    'settings.visibility': 1,
                    'settings.commentsEnabled': 1,
                    'settings.likesVisible': 1,
                    'engagement.likes': 1,
                    'engagement.comments': 1,
                    'engagement.shares': 1,
                    'engagement.saves': 1,
                    'engagement.views': 1,
                    location: 1,
                    tags: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    isPromoted: 1,
                    // Include customization fields (product, service, business, normal)
                    'customization.product': 1,
                    'customization.service': 1,
                    'customization.business': 1,
                    'customization.normal': 1
                }
            }
        ];

        const posts = await Post.aggregate(aggregationPipeline);


        if (posts.length === 0) {
            // Debug: Check if there are ANY posts in the database
            const totalPosts = await Post.countDocuments({});
            const publicPosts = await Post.countDocuments({ 'settings.privacy': 'public' });

            const emptyResponse = new ApiResponse(200, {
                feed: [],
                pagination: { page, limit, total: 0, totalPages: 0 }
            }, "No posts found");

            // Cache empty response for shorter time
            if (res.locals.cacheKey) {
                await setCache(res.locals.cacheKey, emptyResponse, 60);
            }
            return res.status(200).json(emptyResponse);
        }

        // ✅ 3. Get user like status + likedBy from Redis (Hash-based)
        const postIds = posts.map(post => post._id);
        const [likedPostIds, likesByPost, likeCountMap, commentCountMap, sharedCountMap, requestedSet] = await Promise.all([
            userId ? batchIsLikedByUser(userId, postIds) : Promise.resolve(new Set()),
            batchGetLikedByUsers(postIds),
            batchGetLikesCount(posts),
            batchGetCommentsCount(posts),
            batchSharedCount(posts),
            getPendingFollowRequestIdSet(userId)
        ]);

        // ✅ 4. Get top comments efficiently (no nested queries)
        const allComments = await Comment.find({
            postId: { $in: postIds },
            parentCommentId: null,
            isDeleted: false
        })
        .sort({ createdAt: -1 })
        .limit(postIds.length * 3) // Max 3 comments per post
        .populate('userId', 'username profileImageUrl')
        .select('_id content userId createdAt postId')
        .lean();

        // Group comments by postId
        const commentsByPost = new Map();
        allComments.forEach(comment => {
            if (comment.userId) { // Filter out comments from deleted users
                const postId = comment.postId.toString();
                if (!commentsByPost.has(postId)) {
                    commentsByPost.set(postId, []);
                }
                if (commentsByPost.get(postId).length < 3) { // Limit to 3 comments per post
                    commentsByPost.get(postId).push({
                        commentId: comment._id,
                        content: comment.content,
                        createdAt: comment.createdAt,
                        user: {
                            _id: comment.userId._id,
                            username: comment.userId.username,
                            profileImageUrl: comment.userId.profileImageUrl
                        },
                        replies: [] // Don't load replies for performance - load on demand
                    });
                }
            }
        });

        // ✅ 5. Format final response
        const feedData = posts.map(post => {
            const postIdStr = post._id.toString();
            const likedByUsers = likesByPost.get(postIdStr) || [];
            const preview = getLikedByPreview(likedByUsers, userId);
            const authorId = feedPostAuthorId(post);

            return {
                ...post,
                engagement: {
                    ...post.engagement,
                    likes: likeCountMap.get(postIdStr) ?? post.engagement?.likes ?? 0,
                    comments: commentCountMap.get(postIdStr) ?? post.engagement?.comments ?? 0,
                    shares: sharedCountMap.get(postIdStr) ?? post.engagement?.shares ?? 0
                },
                comments: commentsByPost.get(postIdStr) || [],
                isLikedBy: likedPostIds.has(postIdStr),
                likedBy: likedByUsers,
                likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
                isFollowing: !!authorId && followingSet.has(authorId),
                isFollowRequested: !!authorId && requestedSet.has(authorId),
                // True only for the boosted slots; the stored flag is never set.
                isPromoted: promotedPostIdSet.has(postIdStr),
            };
        });
        recordBoostImpressions(
            feedData
                .filter(post => post.isPromoted)
                .map(post => ({ postId: post._id, authorId: feedPostAuthorId(post) })),
            userId
        );
        // Enrich posts with review/rating data
        const enrichedFeedData = await enrichWithRatings(feedData, 'userId');
        
        // Add subscription badges to post authors
        const feedDataWithBadges = await addBadgesToNestedUsers(enrichedFeedData);

        // Get total count for pagination (cached to avoid expensive count queries)
        // Need to count posts excluding unpaid business posts
        let totalCount = posts.length; // Simplified - use actual count for better pagination
        if (page === 1 && posts.length === limit) {
            // Only do count query for first page if it's full
            try {
                // Count all posts, filtering out business content from unpaid business accounts and private posts
                const allPostsForCount = await Post.find({
                    contentType: { $in: ['normal', 'service', 'product', 'business'] },
                    postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
                    userId: { $nin: blockedUsers, $in: viewableUserIds },
                    'settings.privacy': { $ne: 'private' }
                }).select('userId contentType postType').lean();

                // Filter: keep all posts from paid plans, all from non-business,
                // all reels, and only normal contentType from unpaid business accounts
                const filteredPosts = allPostsForCount.filter(post => {
                    const userIdStr = post.userId.toString();
                    // Keep all posts from users with active paid plans
                    if (activePlanUserIdsSet.has(userIdStr)) return true;
                    // Keep all posts from non-business accounts
                    const isBusiness = businessUserIdsSet.has(userIdStr);
                    if (!isBusiness) return true;
                    // Same exemption as the pipeline above — self + followed accounts.
                    // Without it the count disagrees with the page it is counting.
                    if (commercialExemptSet.has(userIdStr)) return true;
                    // Always keep reels regardless of content type or business status
                    if (post.postType === 'reel') return true;
                    // For unpaid business accounts, only keep normal content type
                    return post.contentType === 'normal';
                });

                totalCount = filteredPosts.length;
            } catch (error) {
                totalCount = posts.length; // Fallback
            }
        }

        const response = new ApiResponse(200, {
            feed: feedDataWithBadges,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        }, "Home feed generated successfully");

        // Cache WITHOUT the per-viewer state (isLikedBy, follow state) — all of it
        // is computed fresh on the cache-hit path above to avoid a stale heart or
        // a "Follow" pill on someone the viewer already follows.
        const feedToCache = feedDataWithBadges.map(({ isLikedBy, isFollowing, isFollowRequested, ...rest }) => rest);
        const responseToCache = new ApiResponse(200, {
            feed: feedToCache,
            pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) }
        }, "Home feed generated successfully");
        await setCache(FEED_CACHE_KEY, responseToCache, RedisTTL.USER_FEED);

        return res.status(200).json(response);

    } catch (error) {
        console.error(error);
        throw new ApiError(500, 'Failed to generate home feed');
    }
});
