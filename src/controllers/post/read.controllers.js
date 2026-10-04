import mongoose from 'mongoose';
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import { User } from "../../models/user.models.js";
import Follower from "../../models/follower.models.js";
import { filterPostsByPrivacy, canViewPost } from "../../utils/postPrivacy.js";
import { enrichWithRatings } from "../../utils/reviewUtils.js";
import { addBadgesToNestedUsers } from "../../utils/userBadge.utils.js";
import { getLikedByPreview } from "../../utils/likedByPreview.utils.js";
import { batchIsLikedByUser, batchGetLikesCount, batchGetLikedByUsers, stitchEngagement } from "../../utils/postEngagement.utils.js";
import { hasActivePaymentPlan } from "../../utils/businessPlan.utils.js";
import { getFollowStatus } from '../../utils/followEngagement.utils.js';
import { isBlockedBetween, getBlockedUserIds } from "../../middlewares/blocking.middleware.js";
import { checkContentVisibility, getViewableUserIds } from "../../middlewares/privacy.middleware.js";
// GET /posts/:postId is where every deep link lands — notification taps, order
// references, shared URLs. A deleted post answers with an explicit tombstone
// instead of a 404 the clients render as a blank screen.
import { sendDeletedTombstone } from "../../utils/contentTombstone.utils.js";

/**
 * Post contentTypes a Free business account cannot promote: they are kept out of
 * Explore, Search and the home feeds of non-followers. Mirrors
 * COMMERCIAL_CONTENT_TYPES in businessPlan.utils.js, which is the rule that
 * actually does the filtering. Only used for the "upgrade" banner copy and flags.
 */
const FREE_PLAN_HIDDEN_CONTENT_TYPES = ['product', 'service', 'business'];
const FREE_PLAN_UPGRADE_MESSAGE =
    "Your posts are visible on your profile and to your followers. On the Free plan, your product, service and business listings are not shown in Explore or Search, or in the home feeds of people who don't follow you. Upgrade to reach more people.";
const FREE_PLAN_LISTING_NOTICE = "Not shown in Explore or Search until you upgrade";

/**
 * Is this post's author a private account?
 *
 * `privacy` and `isFullPrivate` are two separate schema fields written
 * together by the privacy toggle but read independently everywhere else —
 * postPrivacy.canViewPost keys off isFullPrivate ALONE, so an account whose
 * `privacy` says 'private' while isFullPrivate is still false (a legacy row,
 * or one written before the toggle set both) fell through to the "post is
 * public, show it" branch and published every post to the whole platform.
 * Either flag being set means private.
 */
const isPrivateAuthor = (author) =>
    !!author && (author.privacy === 'private' || author.isFullPrivate === true);

/**
 * Second gate behind postPrivacy.filterPostsByPrivacy, covering the case that
 * helper cannot see: an author who is private by `privacy` only.
 *
 * Viewer must be the author, or follow / be followed by them — the same
 * relationship filterPostsByPrivacy accepts for isFullPrivate accounts.
 */
const filterPostsByAccountPrivacy = (posts, viewer, viewerFollowing = [], viewerFollowers = []) => {
    const viewerId = viewer?._id?.toString() || null;

    return posts.filter(post => {
        const author = post.userId;
        if (!author) return false;

        const authorId = (author._id ?? author).toString();
        if (viewerId && authorId === viewerId) return true;
        if (!isPrivateAuthor(author)) return true;
        if (!viewerId) return false;

        return viewerFollowing.includes(authorId) || viewerFollowers.includes(authorId);
    });
};

export const getAllPosts = asyncHandler(async (req, res) => {
    const filter = { ...req.query };
    const currentUser = req.user;

    const posts = await Post.find(filter)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .sort({ createdAt: -1 });

    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    let visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);
    visiblePosts = filterPostsByAccountPrivacy(visiblePosts, currentUser, viewerFollowing, viewerFollowers);

    // Blocked in either direction — neither side's posts are returned.
    if (currentUser) {
        const blockedIds = await getBlockedUserIds(currentUser._id);
        if (blockedIds.length) {
            const blockedSet = new Set(blockedIds);
            visiblePosts = visiblePosts.filter(post => {
                const authorId = (post.userId?._id ?? post.userId)?.toString();
                return !authorId || !blockedSet.has(authorId);
            });
        }
    }

    visiblePosts = await enrichWithRatings(visiblePosts, 'userId');
    const postsWithBadges = await addBadgesToNestedUsers(visiblePosts);

    return res.status(200).json(new ApiResponse(200, postsWithBadges, "Posts fetched successfully"));
});

export const getPostById = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const currentUser = req.user;

    const post = await Post.findById(postId)
        .populate('userId', 'username fullName profileImageUrl privacy isFullPrivate')
        .lean();

    // The post row is gone — say so. 200 with an explicit marker, because this is
    // the destination of links the caller legitimately holds and a 404 reads to
    // them as a broken app, not as "the owner took it down".
    //
    // `_id` is echoed back so a client keyed on the id it asked for can still
    // slot the tombstone into place; nothing else about the post is returned,
    // because nothing else exists.
    if (!post) {
        return sendDeletedTombstone(res, {
            contentType: 'post',
            contentId: postId,
            extra: { _id: postId },
        });
    }

    // NOT a tombstone: the post still exists, it is the AUTHOR who is gone or
    // suspended. Answering "deleted by the owner" here would assert something
    // untrue, and these branches deliberately reveal nothing at all — keep 404.
    const postOwner = await User.findById(post.userId?._id || post.userId)
        .select('accountStatus isDeleted').lean();
    if (!postOwner || postOwner.isDeleted || postOwner.accountStatus !== 'active') {
        throw new ApiError(404, "Post not found");
    }

    const postAuthorIdForChecks = post.userId?._id || post.userId;

    // A block in EITHER direction hides the post outright. 404 rather than
    // 403: whether a given post exists is itself information the blocked
    // party should not get, and it matches how a deleted author is answered
    // just above.
    if (currentUser && await isBlockedBetween(currentUser._id, postAuthorIdForChecks)) {
        throw new ApiError(404, "Post not found");
    }

    const isFollowing = await getFollowStatus(currentUser?._id, post.userId?._id || post.userId);

    let viewerFollowing = [];
    let viewerFollowers = [];

    if (currentUser) {
        const followingRecords = await Follower.find({ followerId: currentUser._id });
        const followerRecords = await Follower.find({ userId: currentUser._id });

        viewerFollowing = followingRecords.map(f => f.userId.toString());
        viewerFollowers = followerRecords.map(f => f.followerId.toString());
    }

    if (!canViewPost(post, post.userId, currentUser, viewerFollowing, viewerFollowers)) {
        throw new ApiError(403, "You don't have permission to view this post");
    }

    // canViewPost only knows about isFullPrivate; this covers an author who is
    // private by the `privacy` field alone.
    if (!filterPostsByAccountPrivacy([post], currentUser, viewerFollowing, viewerFollowers).length) {
        throw new ApiError(403, "This account is private. Follow to see their posts.");
    }

    const postAuthorId = post.userId?._id || post.userId;
    const postAuthor = await User.findById(postAuthorId).select('isBusinessProfile').lean();
    const isViewingOwnPost = currentUser && currentUser._id.toString() === postAuthorId.toString();

    if (postAuthor?.isBusinessProfile && isViewingOwnPost) {
        const hasActivePlan = await hasActivePaymentPlan(postAuthorId);
        if (!hasActivePlan && FREE_PLAN_HIDDEN_CONTENT_TYPES.includes(post.contentType)) {
            post.isHiddenFromFeed = true;
            post.visibilityMessage = FREE_PLAN_LISTING_NOTICE;
            post.upgradeMessage = {
                title: "Upgrade Plan",
                message: FREE_PLAN_UPGRADE_MESSAGE,
                ctaText: "Upgrade Now",
                ctaUrl: "/business/select-plan"
            };
        } else {
            post.isHiddenFromFeed = false;
        }
    }

    const [likedByMap, likedSet, likeCountMap] = await Promise.all([
        batchGetLikedByUsers([postId]),
        currentUser ? batchIsLikedByUser(currentUser._id, [postId]) : Promise.resolve(new Set()),
        batchGetLikesCount([post]),
    ]);

    const postIdStr = postId.toString();
    let likedByUsers = likedByMap.get(postIdStr) || [];
    const currentUserLiked = currentUser ? likedSet.has(postIdStr) : false;

    if (currentUserLiked) {
        const curIdStr = currentUser._id.toString();
        if (!likedByUsers.find(u => (u._id || u.userId)?.toString() === curIdStr)) {
            likedByUsers = [{
                _id: curIdStr,
                userId: curIdStr,
                username: currentUser.username,
                fullName: currentUser.fullName,
                profileImageUrl: currentUser.profileImageUrl,
                isVerified: currentUser.isVerified,
            }, ...likedByUsers];
        }
    }

    post.likedBy = likedByUsers;
    post.isLikedBy = currentUserLiked;
    post.engagement = {
        ...(post.engagement || {}),
        likes: likeCountMap.get(postIdStr) ?? post.engagement?.likes ?? 0,
    };

    if (currentUser) {
        const preview = getLikedByPreview(likedByUsers, currentUser._id.toString());
        post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
    }

    const [postWithBadge] = await addBadgesToNestedUsers([post]);

    return res.status(200).json(new ApiResponse(200, { ...postWithBadge, isFollowing }, "Post fetched successfully"));
});

export const getMyPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, "Unauthorized: User ID missing");

    const { postType, contentType } = req.query;
    let { page, limit } = req.query;

    page = parseInt(page) > 0 ? parseInt(page) : 1;
    limit = parseInt(limit) > 0 ? parseInt(limit) : 10;

    const filter = { userId };
    if (postType) filter.postType = postType;
    if (contentType) filter.contentType = contentType;

    const posts = await Post.find(filter)
        .populate('userId', 'username profileImageUrl fullName isVerified location bio')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);

    const total = await Post.countDocuments(filter);

    const postsWithThumbnails = posts.map(post => {
        const postObj = post.toObject();
        postObj.media = (postObj.media || []).map(media => {
            let thumbnailUrl = media.thumbnailUrl ?? null;
            if (
                media.type === "video" &&
                (!thumbnailUrl || thumbnailUrl === "null") &&
                typeof media.url === "string"
            ) {
                thumbnailUrl = media.url
                    .replace('/upload/', '/upload/w_300,h_300,c_fill,so_1/')
                    .replace(/\.(mp4|mov|webm)$/i, '.jpg');
            }
            return { ...media, thumbnailUrl };
        });
        return postObj;
    });

    const currentUserId = req.user?._id?.toString();
    const [likedSet, likeCountMap, likedByUsersMap] = await Promise.all([
        currentUserId ? batchIsLikedByUser(req.user._id, postsWithThumbnails.map(p => p._id)) : Promise.resolve(new Set()),
        batchGetLikesCount(postsWithThumbnails),
        batchGetLikedByUsers(postsWithThumbnails.map(p => p._id)),
    ]);

    postsWithThumbnails.forEach(post => {
        const idStr = post._id.toString();
        post.isLikedBy = currentUserId ? likedSet.has(idStr) : false;
        post.likedBy = likedByUsersMap.get(idStr) || [];
        post.engagement = { ...(post.engagement || {}), likes: likeCountMap.get(idStr) ?? post.engagement?.likes ?? 0 };
    });

    postsWithThumbnails.forEach(post => {
        const preview = getLikedByPreview(post.likedBy || [], currentUserId);
        post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
    });

    const enrichedPosts = await enrichWithRatings(postsWithThumbnails, 'userId');
    const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

    let upgradeMessage = null;
    let hiddenPostsCount = 0;
    const { User } = await import('../../models/user.models.js');
    const currentUserData = await User.findById(userId).select('isBusinessProfile').lean();

    if (currentUserData?.isBusinessProfile) {
        const { hasActivePaymentPlan } = await import('../../utils/businessPlan.utils.js');
        const hasActivePlan = await hasActivePaymentPlan(userId);

        if (!hasActivePlan) {
            // Only product, service and business listings are withheld from
            // discovery on the Free plan (see filterBusinessPostsByPaymentPlan in
            // businessPlan.utils.js). Everything else, and every post for the
            // author and their followers, is shown as normal, so only listings
            // are flagged and counted. If those discovery rules change, change
            // this copy too.
            const isListing = (post) => FREE_PLAN_HIDDEN_CONTENT_TYPES.includes(post.contentType);
            hiddenPostsCount = postsWithBadges.filter(isListing).length;
            upgradeMessage = {
                title: "Upgrade Plan",
                message: FREE_PLAN_UPGRADE_MESSAGE,
                ctaText: "Upgrade Now",
                ctaUrl: "/business/select-plan"
            };
            postsWithBadges.forEach(post => {
                if (isListing(post)) {
                    post.isHiddenFromFeed = true;
                    post.visibilityMessage = FREE_PLAN_LISTING_NOTICE;
                } else {
                    post.isHiddenFromFeed = false;
                }
            });
        } else {
            postsWithBadges.forEach(post => {
                post.isVisibleToOthers = true;
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            totalPosts: total,
            page,
            totalPages: Math.ceil(total / limit),
            posts: postsWithBadges,
            upgradeMessage,
            hiddenPostsCount
        }, "User posts fetched successfully")
    );
});

export const getUserProfilePosts = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const {
        postType,
        contentType,
        page,
        limit,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;

    if (!userId) {
        throw new ApiError(400, "User ID is required");
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new ApiError(400, "Invalid User ID format");
    }

    const currentUserForGate = req.user;
    const isOwnProfileRequest = currentUserForGate
        && currentUserForGate._id.toString() === userId.toString();

    // SERVER-SIDE privacy and blocking gate, before a single post is read.
    //
    // This endpoint used to answer for any caller and lean entirely on
    // postPrivacy.filterPostsByPrivacy afterwards, which (a) only understands
    // isFullPrivate, so an account private by the `privacy` field alone was
    // fully readable, and (b) knows nothing about blocking, so a blocked
    // user's whole profile grid came back — the route does not even mount the
    // getBlockedUsers middleware. checkContentVisibility settles all three
    // questions together: block in either direction, account privacy by
    // either flag, and whether the viewer follows.
    if (!isOwnProfileRequest) {
        const canView = await checkContentVisibility(currentUserForGate?._id, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their posts.");
        }
    }

    const currentPage = parseInt(page) || 1;
    const pageLimit = parseInt(limit) || 20;
    const skip = (currentPage - 1) * pageLimit;

    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDirection };

    const filter = {
        userId,
        status: { $in: ['published', 'scheduled'] }
    };

    // Posts the author marked private stay with the author. Applied in the
    // QUERY, not only in the post-fetch filter, so `totalPosts` and the page
    // boundaries agree with what is actually returned — filtering after the
    // .limit() left visitors with short or empty pages and a count that
    // promised posts they were never going to be shown.
    if (!isOwnProfileRequest) {
        filter['settings.privacy'] = { $ne: 'private' };
    }

    if (postType) {
        const validPostTypes = ['photo', 'reel', 'video'];
        if (!validPostTypes.includes(postType.toLowerCase())) {
            throw new ApiError(400, "Invalid post type. Must be one of: photo, reel, video");
        }
        filter.postType = postType.toLowerCase();
    }

    if (contentType) {
        const validContentTypes = ['normal', 'business', 'product', 'service'];
        if (!validContentTypes.includes(contentType.toLowerCase())) {
            throw new ApiError(400, "Invalid content type. Must be one of: normal, business, product, service");
        }
        filter.contentType = contentType.toLowerCase();
    }

    try {
        const posts = await Post.find(filter)
            .populate('userId', 'username profileImageUrl fullName isVerified location bio privacy isFullPrivate')
            .populate('mentions', 'username fullName profileImageUrl')
            .sort(sortObj)
            .skip(skip)
            .limit(pageLimit)
            .lean();

        const currentUser = req.user;
        let viewerFollowing = [];
        let viewerFollowers = [];

        if (currentUser) {
            const followingRecords = await Follower.find({ followerId: currentUser._id });
            const followerRecords = await Follower.find({ userId: currentUser._id });

            viewerFollowing = followingRecords.map(f => f.userId.toString());
            viewerFollowers = followerRecords.map(f => f.followerId.toString());
        }

        let visiblePosts = filterPostsByPrivacy(posts, currentUser, viewerFollowing, viewerFollowers);
        visiblePosts = filterPostsByAccountPrivacy(visiblePosts, currentUser, viewerFollowing, viewerFollowers);

        const isViewingOwnProfile = isOwnProfileRequest;

        let postsAfterBusinessFilter;
        let upgradeMessage = null;
        let hiddenPostsCount = 0;

        if (isViewingOwnProfile) {
            postsAfterBusinessFilter = visiblePosts;

            const { User } = await import('../../models/user.models.js');
            const profileUser = await User.findById(userId).select('isBusinessProfile').lean();

            if (profileUser?.isBusinessProfile) {
                const { hasActivePaymentPlan } = await import('../../utils/businessPlan.utils.js');
                const hasActivePlan = await hasActivePaymentPlan(userId);

                if (!hasActivePlan) {
                    // Only listings are withheld from discovery on the Free plan
                    // (see getMyPosts), so only they are flagged and counted.
                    const isListing = (post) => FREE_PLAN_HIDDEN_CONTENT_TYPES.includes(post.contentType);
                    hiddenPostsCount = visiblePosts.filter(isListing).length;
                    upgradeMessage = {
                        title: "Upgrade Plan",
                        message: FREE_PLAN_UPGRADE_MESSAGE,
                        ctaText: "Upgrade Now",
                        ctaUrl: "/business/select-plan"
                    };
                    postsAfterBusinessFilter.forEach(post => {
                        if (isListing(post)) {
                            post.isHiddenFromFeed = true;
                            post.visibilityMessage = FREE_PLAN_LISTING_NOTICE;
                        } else {
                            post.isHiddenFromFeed = false;
                        }
                    });
                } else {
                    postsAfterBusinessFilter.forEach(post => {
                        post.isHiddenFromFeed = false;
                    });
                }
            }
        } else {
            postsAfterBusinessFilter = visiblePosts;
        }

        const totalPosts = await Post.countDocuments(filter);
        const totalPages = Math.ceil(totalPosts / pageLimit);

        const currentUserId = req.user?._id?.toString();
        const [likedSet, likeCountMap, likedByUsersMap] = await Promise.all([
            currentUserId ? batchIsLikedByUser(req.user._id, postsAfterBusinessFilter.map(p => p._id)) : Promise.resolve(new Set()),
            batchGetLikesCount(postsAfterBusinessFilter),
            batchGetLikedByUsers(postsAfterBusinessFilter.map(p => p._id)),
        ]);

        postsAfterBusinessFilter.forEach(post => {
            const idStr = post._id.toString();
            post.isLikedBy = currentUserId ? likedSet.has(idStr) : false;
            post.likedBy = likedByUsersMap.get(idStr) || [];
            post.engagement = { ...(post.engagement || {}), likes: likeCountMap.get(idStr) ?? post.engagement?.likes ?? 0 };
        });

        if (currentUser) {
            postsAfterBusinessFilter.forEach(post => {
                const preview = getLikedByPreview(post.likedBy || [], currentUserId);
                post.likedByPreview = preview.likedByText ? { text: preview.likedByText, previewUser: preview.previewUser, othersCount: preview.othersCount } : null;
            });
        }

        const enrichedPosts = await enrichWithRatings(postsAfterBusinessFilter, 'userId');
        const postsWithBadges = await addBadgesToNestedUsers(enrichedPosts);

        // description is NOT stripped.
        //
        // It used to be deleted from every post here, with no reason recorded.
        // For posts created in the app that is the only copy of the text — the
        // app writes the body into `description` and leaves `caption` for the
        // short line — so the profile grid showed those posts with nothing
        // written on them at all.

        return res.status(200).json(
            new ApiResponse(200, {
                posts: postsWithBadges,
                pagination: {
                    currentPage,
                    totalPages,
                    totalPosts,
                    hasNextPage: currentPage < totalPages,
                    hasPrevPage: currentPage > 1,
                    limit: pageLimit
                },
                filters: {
                    postType: postType || 'all',
                    contentType: contentType || 'all'
                },
                upgradeMessage,
                hiddenPostsCount,
                isViewingOwnProfile
            }, "User profile posts fetched successfully")
        );
    } catch (error) {
        console.error("Error fetching user profile posts:", error);
        throw new ApiError(500, "Failed to fetch user profile posts");
    }
});

/**
 * Restricts a set of posts to authors the viewer is allowed to see.
 *
 * getViewableUserIds resolves to "followers + own + public accounts" for a
 * signed-in viewer and "public accounts only" for an anonymous one, so it is
 * the same account-privacy rule the home feed applies; the blocked list then
 * removes both directions of any block. The two aggregate feeds below had
 * NEITHER, and returned private accounts' and blocked users' posts verbatim.
 */
const restrictToViewableAuthors = async (posts, viewerId) => {
    if (!posts.length) return posts;

    const [viewableIds, blockedIds] = await Promise.all([
        getViewableUserIds(viewerId ? viewerId.toString() : null),
        getBlockedUserIds(viewerId)
    ]);

    const viewableSet = new Set(viewableIds.map(id => id.toString()));
    const blockedSet = new Set(blockedIds.map(id => id.toString()));

    return posts.filter(post => {
        const authorId = (post.userId?._id ?? post.userId)?.toString();
        if (!authorId) return false;
        return viewableSet.has(authorId) && !blockedSet.has(authorId);
    });
};

export const getNearbyPosts = asyncHandler(async (req, res) => {
    const { latitude, longitude, distance = 1000 } = req.query;
    if (!latitude || !longitude) {
        throw new ApiError(400, "Latitude and longitude are required");
    }

    const posts = await Post.find({
        "customization.normal.location.coordinates": {
            $near: {
                $geometry: {
                    type: "Point",
                    coordinates: [parseFloat(longitude), parseFloat(latitude)]
                },
                $maxDistance: parseInt(distance)
            }
        },
        "settings.privacy": { $ne: "private" }
    }).lean();

    const visible = await restrictToViewableAuthors(posts, req.user?._id ?? null);

    return res.status(200).json(new ApiResponse(200, visible, "Nearby posts fetched successfully"));
});

export const getTrendingPosts = asyncHandler(async (req, res) => {
    const currentUser = req.user ?? null;

    // Over-fetch, then gate, then trim: filtering after a .limit(20) would
    // hand back fewer than 20 whenever anything was removed.
    const posts = await Post.find({ "settings.privacy": { $ne: "private" } })
        .sort({ "engagement.likes": -1, "engagement.comments": -1, createdAt: -1 })
        .limit(100)
        .lean();

    const visible = (await restrictToViewableAuthors(posts, currentUser?._id ?? null)).slice(0, 20);

    if (!visible.length) {
        return res.status(200).json(new ApiResponse(200, visible, "Trending posts fetched successfully"));
    }

    const stitched = await stitchEngagement(currentUser?._id ?? null, visible);

    return res.status(200).json(new ApiResponse(200, stitched, "Trending posts fetched successfully"));
});
