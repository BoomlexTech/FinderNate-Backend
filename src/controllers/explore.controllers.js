import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import { User } from "../models/user.models.js";
import Business from "../models/business.models.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getViewableUserIds } from "../middlewares/privacy.middleware.js";
import { enrichWithRatings } from "../utils/reviewUtils.js";
import { addBadgesToNestedUsers, addBadgesToUsers } from "../utils/userBadge.utils.js";
import { filterBusinessPostsByPaymentPlan } from "../utils/businessPlan.utils.js";
import { batchIsLikedByUser, batchGetLikedByUsers, batchGetLikesCount, batchSharedCount } from "../utils/postEngagement.utils.js";
import { getLikedByPreview } from "../utils/likedByPreview.utils.js";
import { getLiveBoosts, isCorporateBusinessPlan, orderPaidForExplore, recordBoostImpressions } from "../utils/boostServing.js";
import mongoose from "mongoose";

export const getExploreFeed = asyncHandler(async (req, res) => {
    let { contentType, types, postType, sortBy = "time", page = 1, limit = 10 } = req.query;
    // `types` is the legacy name the mobile app sends. It was never read here,
    // so contentType silently fell back to "all" on every app request — and the
    // "all" branch used to strip every vibe out of the feed.
    contentType = contentType || types || "all";
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 10;

    // Get blocked users from middleware
    const blockedUsers = req.blockedUsers || [];
    
    // Get viewable user IDs based on privacy settings
    const viewerId = req.user?._id;
    const viewableUserIds = await getViewableUserIds(viewerId);


    // If contentType=all, fetch all allowed types; otherwise, use the provided contentType
    const allowedTypes = ['normal', 'service', 'product', 'business'];
    let postMatch = {};

    if (contentType !== "all") {
        const typeArray = contentType.split(",").map(t => t.trim().toLowerCase());
        postMatch.contentType = { $in: typeArray };
        // When filtering by specific contentType, include ALL postTypes (including reels)
    } else {
        // Vibes (postType 'reel') used to be excluded here, on the assumption
        // that the separate legacy-Reel query below covered them. It does not:
        // real vibes are Post documents, and that collection is dead. The
        // result was an explore/search browse feed with no vibes in it at all.
        postMatch.contentType = { $in: allowedTypes };
    }

    // Optional post-type narrowing (photo | reel | video | tweet). The app's
    // filter sheet offers these chips; without this they had nowhere to go.
    if (postType) {
        const postTypeArray = postType.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
        if (postTypeArray.length) postMatch.postType = { $in: postTypeArray };
    }

    // 1. Vibes now come from the posts query above (postType 'reel' on a Post
    //    document). The old code sampled 2 documents from the legacy `Reel`
    //    collection instead — that collection is dead, and its schema has no
    //    media[]/postType/contentType, so the mobile client parsed those docs
    //    into empty cards. Kept as an empty array because the enrichment and
    //    response-shaping code below still reads it.
    let reels = [];
    let paidBusinessStories = []; // Initialize paid business stories array

    // 2. Get posts using reliable find() method like homeFeed (not aggregation)
    const EXPLORE_LIMIT = 100;

    // Get active payment plan user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId plan').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));
    const paidPlanByUserId = new Map(activePaymentPlanUserIds.map(b => [b.userId.toString(), b.plan]));

    const liveBoosts = await getLiveBoosts(paidPlanByUserId);

    // Get all posts matching the criteria using the same reliable approach as homeFeed (excluding blocked users and respecting privacy)
    const recentPosts = await Post.find({
        ...postMatch,
        userId: { $in: viewableUserIds, $nin: blockedUsers },
        'settings.privacy': { $ne: 'private' }  // Never show private posts in public feeds
    })
        .sort({ createdAt: -1 })
        .limit(EXPLORE_LIMIT)
        .populate('userId', 'username profileImageUrl')
        .select('-analytics -__v -settings.customAudience');

    // A boost on a post older than the newest EXPLORE_LIMIT would never reach the
    // candidate list above, so fetch those under the same visibility rules.
    const recentPostIds = new Set(recentPosts.map(post => post._id.toString()));
    const olderBoostedIds = liveBoosts.map(boost => boost.postId).filter(id => !recentPostIds.has(id));
    const olderBoostedPosts = olderBoostedIds.length === 0 ? [] : await Post.find({
        ...postMatch,
        _id: { $in: olderBoostedIds },
        userId: { $in: viewableUserIds, $nin: blockedUsers },
        'settings.privacy': { $ne: 'private' }
    })
        .populate('userId', 'username profileImageUrl')
        .select('-analytics -__v -settings.customAudience');
    const allPosts = [...recentPosts, ...olderBoostedPosts];

    // Filter out unpaid business posts
    const filteredPosts = await filterBusinessPostsByPaymentPlan(allPosts);

    // Separate paid business posts and regular posts for interspersing
    const paidBusinessPosts = [];
    const regularPosts = [];

    const authorIdOf = (post) => (post.userId?._id || post.userId)?.toString();
    const boostWeightByPostId = new Map(liveBoosts.map(boost => [boost.postId, boost.weight]));
    // Boosted posts that are actually in the paid bucket below. A post reported
    // since its boost started no longer counts.
    const promotedPostIds = new Set();

    // Get business user IDs
    const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
    const businessUserIdsSet = new Set(businessUsers.map(u => u._id.toString()));

    filteredPosts.forEach(post => {
        const userId = post.userId?._id || post.userId;
        const userIdStr = userId ? userId.toString() : null;
        const isBusiness = userIdStr && businessUserIdsSet.has(userIdStr);
        const hasActivePlan = userIdStr && activePlanUserIdsSet.has(userIdStr);
        
        if (isBusiness && hasActivePlan) {
            paidBusinessPosts.push(post);
            const postIdStr = post._id.toString();
            if (post.isReported !== true && boostWeightByPostId.has(postIdStr)) promotedPostIds.add(postIdStr);
        } else {
            regularPosts.push(post);
        }
    });

    // Shuffle arrays separately
    function shuffleArray(arr) {
        return arr
            .map(value => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);
    }

    const shuffledRegularPosts = shuffleArray(regularPosts);
    // Paid-author posts take 1 of every 5 slots below, in this order: boosted
    // posts (Corporate boosts first), then the rest of Corporate, then Small
    // Business. Boosted posts can therefore never take more than those slots.
    const shuffledPaidBusinessPosts = orderPaidForExplore(paidBusinessPosts, {
        boostWeightOf: (post) => promotedPostIds.has(post._id.toString()) ? boostWeightByPostId.get(post._id.toString()) : 0,
        isCorporateOf: (post) => isCorporateBusinessPlan(paidPlanByUserId.get(authorIdOf(post)))
    }, shuffleArray);

    // Intersperse paid business posts between regular posts
    // Insert 1 paid business post every 3-5 regular posts
    let posts = [];
    let regularIndex = 0;
    let paidIndex = 0;
    const insertInterval = 4; // Insert paid post every 4 regular posts
    
    while (regularIndex < shuffledRegularPosts.length || paidIndex < shuffledPaidBusinessPosts.length) {
        // Add regular posts
        const regularBatch = shuffledRegularPosts.slice(regularIndex, regularIndex + insertInterval);
        posts.push(...regularBatch);
        regularIndex += insertInterval;
        
        // Add one paid business post if available
        if (paidIndex < shuffledPaidBusinessPosts.length) {
            posts.push(shuffledPaidBusinessPosts[paidIndex]);
            paidIndex++;
        }
        
        // Break if we've added enough posts
        if (posts.length >= EXPLORE_LIMIT) {
            posts = posts.slice(0, EXPLORE_LIMIT);
            break;
        }
    }

    // Apply sorting if requested (but keep shuffled by default)
    if (sortBy !== "time") {
        posts = posts.sort((a, b) => {
            switch (sortBy) {
                case "likes":
                    return (b.engagement?.likes || 0) - (a.engagement?.likes || 0);
                case "comments":
                    return (b.engagement?.comments || 0) - (a.engagement?.comments || 0);
                case "shares":
                    return (b.engagement?.shares || 0) - (a.engagement?.shares || 0);
                case "views":
                    return (b.engagement?.views || 0) - (a.engagement?.views || 0);
                case "engagement":
                    const aEng = (a.engagement?.likes || 0) + (a.engagement?.comments || 0) + (a.engagement?.shares || 0) + (a.engagement?.views || 0);
                    const bEng = (b.engagement?.likes || 0) + (b.engagement?.comments || 0) + (b.engagement?.shares || 0) + (b.engagement?.views || 0);
                    return bEng - aEng;
                default:
                    return 0; // Keep shuffled order
            }
        });
    }

    // Paginate posts. Vibes are ordinary posts now, so every branch paginates
    // the full page size — reserving postsPerPage for the (now empty) separate
    // reel query would silently drop 2 items per page.
    const skip = (page - 1) * limit;
    const take = limit;
    posts = posts.slice(skip, skip + take);

    recordBoostImpressions(
        posts
            .filter(post => promotedPostIds.has(post._id.toString()))
            .map(post => ({ postId: post._id, authorId: authorIdOf(post) })),
        viewerId
    );

    // Handle reel user details (reels need separate user fetching)
    if (reels.length > 0) {
        const reelUserIds = [...new Set(reels.map(reel => reel.userId))].filter(id => id != null);

        const reelUsers = await User.find(
            { _id: { $in: reelUserIds } },
            { _id: 1, username: 1, fullName: 1, profileImageUrl: 1 }
        );

        const reelUserMap = {};
        reelUsers.forEach(user => {
            reelUserMap[user._id.toString()] = user;
        });

        reels.forEach(reel => {
            const user = reelUserMap[reel.userId?.toString()];
            if (user) {
                reel.userId = {
                    _id: user._id,
                    username: user.username,
                    fullName: user.fullName
                };
                reel.profileImageUrl = user.profileImageUrl;
            } else {
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
    }

    // Posts already have populated user details from the query

    // Enrich posts with review/rating data
    posts = await enrichWithRatings(posts, 'userId');
    
    // Add subscription badges to post authors
    posts = await addBadgesToNestedUsers(posts);

    // Combine and shuffle final feed based on query type
    let feed, totalAvailable, totalPages, hasNextPage;

    if (contentType === "all") {
        // For contentType=all, combine reels, posts, and business stories
        feed = [
            ...reels.map(r => ({ ...r, _type: "reel", location: null })), // Legacy reels don't have location
            ...paidBusinessStories.map(s => ({
                ...s,
                _type: "business_story",
                postType: s.mediaType,
                location: null
            })),
            ...posts.map(p => {
                const post = p.toObject ? p.toObject() : p;

                // Extract location from customization based on contentType
                let location = null;
                if (post.customization) {
                    if (post.contentType && post.customization[post.contentType]?.location) {
                        location = post.customization[post.contentType].location;
                    } else if (post.customization.normal?.location) {
                        location = post.customization.normal.location;
                    }
                }

                // Ensure location has proper structure with name and coordinates
                if (location && (location.name || location.coordinates)) {
                    location = {
                        name: location.name || null,
                        coordinates: location.coordinates || null,
                        // Include other location fields if they exist
                        ...(location.address && { address: location.address }),
                        ...(location.city && { city: location.city }),
                        ...(location.state && { state: location.state }),
                        ...(location.country && { country: location.country }),
                        ...(location.type && { type: location.type })
                    };
                }

                return {
                    ...post,
                    _type: post.postType === "reel" ? "reel" : "post",
                    location
                };
            })
        ];

        // Final shuffle of the combined feed for variety
        for (let i = feed.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [feed[i], feed[j]] = [feed[j], feed[i]];
        }

        totalAvailable = allPosts.length;
        // Matches the `take = limit` slice above; postsPerPage would overstate
        // the page count now that nothing is reserved for a separate reel query.
        totalPages = Math.ceil(totalAvailable / limit);
        hasNextPage = page < totalPages;
    } else {
        // For specific contentType, everything comes from posts query
        feed = posts.map(p => {
            const post = p.toObject ? p.toObject() : p;

            // Extract location from customization based on contentType
            let location = null;
            if (post.customization) {
                if (post.contentType && post.customization[post.contentType]?.location) {
                    location = post.customization[post.contentType].location;
                } else if (post.customization.normal?.location) {
                    location = post.customization.normal.location;
                }
            }

            // Ensure location has proper structure with name and coordinates
            if (location && (location.name || location.coordinates)) {
                location = {
                    name: location.name || null,
                    coordinates: location.coordinates || null,
                    // Include other location fields if they exist
                    ...(location.address && { address: location.address }),
                    ...(location.city && { city: location.city }),
                    ...(location.state && { state: location.state }),
                    ...(location.country && { country: location.country }),
                    ...(location.type && { type: location.type })
                };
            }

            return {
                ...post,
                _type: post.postType === "reel" ? "reel" : "post",
                location
            };
        });

        totalAvailable = allPosts.length;
        totalPages = Math.ceil(totalAvailable / limit);
        hasNextPage = page < totalPages;
    }

    // Stitch like engagement onto feed items
    const currentUserId = req.user?._id ?? null;
    const feedIds = feed.map(item => item._id).filter(Boolean);
    if (feedIds.length) {
        const [likedSet, likedByMap, likeCountMap, sharedCountMap] = await Promise.all([
            currentUserId ? batchIsLikedByUser(currentUserId, feedIds) : Promise.resolve(new Set()),
            batchGetLikedByUsers(feedIds),
            batchGetLikesCount(feed),
            batchSharedCount(feed)
        ]);
        feed = feed.map(item => {
            const idStr = item._id?.toString();
            if (!idStr) return item;
            const likedByUsers = likedByMap.get(idStr) || [];
            const preview = getLikedByPreview(likedByUsers, currentUserId);
            return {
                ...item,
                engagement: {
                    ...item.engagement,
                    likes: likeCountMap.get(idStr) ?? item.engagement?.likes ?? 0,
                    shares: sharedCountMap.get(idStr) ?? item.engagement?.shares ?? 0
                },
                isLikedBy: currentUserId ? likedSet.has(idStr) : false,
                isPromoted: promotedPostIds.has(idStr),
                likedBy: likedByUsers,
                likedByPreview: preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null,
            };
        });
    }

    res.status(200).json(new ApiResponse(200, {
        feed,
        pagination: {
            page,
            limit,
            reelsCount: contentType === "all" ? reels.length : feed.filter(item => item._type === "reel").length,
            postsCount: contentType === "all" ? posts.length : feed.filter(item => item._type === "post").length,
            businessStoriesCount: contentType === "all" ? paidBusinessStories.length : 0,
            total: feed.length,
            totalAvailable,
            totalPages,
            hasNextPage
        }
    }, "Explore feed generated"));
});