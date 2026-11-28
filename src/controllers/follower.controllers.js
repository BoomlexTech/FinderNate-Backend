import Follower from "../models/follower.models.js";
import FollowRequest from "../models/followRequest.models.js";
import { User } from "../models/user.models.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { createFollowNotification } from "./notification.controllers.js";
import { redisClient, RedisKeys, RedisTTL, FOLLOW_LIST_MAX } from "../config/redis.config.js";

const LIST_TTL = RedisTTL.FOLLOW_LIST;
import { addBadgesToUsers } from "../utils/userBadge.utils.js";
import { invalidateViewableUsersCache, checkContentVisibility } from "../middlewares/privacy.middleware.js";
import socketManager from "../config/socket.js";
import {
    getFollowStatus,
    onUserFollowed,
    onUserUnfollowed,
    getFollowersCount,
    getFollowingCount,
    getFollowingIdSet,
    getPendingFollowRequestIdSet,
} from "../utils/followEngagement.utils.js";

/**
 * Says, for each person in a followers / following list, how the VIEWER stands
 * with them: `isFollowing` (the viewer follows them), `isPending` (the viewer
 * asked to follow a private account and is waiting) and `isMe`.
 *
 * The lists used to carry none of this, so the page could not draw a Follow /
 * Following button that was right, and both clients drew a decoration there
 * instead (client list, 28 Nov 2026, item 21). Two reads for the whole page,
 * not one per row.
 */
export const withViewerFollowState = async (users, viewerId) => {
    if (!Array.isArray(users) || users.length === 0) return users || [];
    const viewer = viewerId ? String(viewerId) : '';
    const [following, pending] = viewer
        ? await Promise.all([getFollowingIdSet(viewer), getPendingFollowRequestIdSet(viewer)])
        : [new Set(), new Set()];
    return users.map((user) => {
        const id = String(user?._id || '');
        return {
            ...user,
            isMe: !!viewer && id === viewer,
            isFollowing: following.has(id),
            isPending: !following.has(id) && pending.has(id),
        };
    });
};

// Follow a user (with privacy support)
export const followUser = asyncHandler(async (req, res) => {
    try{

        const requesterId = req.user._id;
        const { userId } = req.body; // userId to follow
        
        if (requesterId.toString() === userId) {
            throw new ApiError(400, "You cannot follow yourself");
    }
    
    // Check follow status: Redis first ('1'/'0'), DB fallback on miss or Redis down
    const alreadyFollowing = await getFollowStatus(requesterId, userId);
    if (alreadyFollowing) throw new ApiError(400, "Already following");
    
    // Check if there's ANY existing follow request (pending, rejected, or approved)
    const existingRequest = await FollowRequest.findOne({
        requesterId,
        recipientId: userId
    });

    // If there's a pending request, inform the user
    if (existingRequest && existingRequest.status === 'pending') {
        throw new ApiError(400, "Follow request already sent");
    }
    
    // Get the user to follow
    const targetUser = await User.findById(userId).select('username fullName profileImageUrl privacy');
    if (!targetUser) throw new ApiError(404, "User not found");
    
    // If target user has public account, follow immediately
    if (targetUser.privacy === 'public') {
        // Delete any old follow request records (rejected or approved)
        if (existingRequest) {
            await FollowRequest.findByIdAndDelete(existingRequest._id);
        }
        
        // Write-through: DB + Redis in onUserFollowed
        const result = await onUserFollowed(requesterId, userId);

        let newFollowersCount = result.followersCount ?? null;
        let newFollowingCount = result.followingCount ?? null;

        if (!result.ok) {
            // DB write inside onUserFollowed already failed — read fresh counts
            try {
                [newFollowersCount, newFollowingCount] = await Promise.all([
                    Follower.countDocuments({ userId }),
                    Follower.countDocuments({ followerId: requesterId }),
                ]);
            } catch { /* counts remain null in response */ }
        }
        
        // Notification + cache invalidation fire-and-forget
        createFollowNotification({ recipientId: userId, sourceUserId: requesterId })?.catch(() => {});
        invalidateViewableUsersCache(requesterId)?.catch(() => {});
        invalidateViewableUsersCache(userId)?.catch(() => {});

        if (newFollowersCount !== null && newFollowingCount !== null) {
            socketManager.emitGlobal('follow_status_updated', {
                followedUserId: userId,
                followersCount: newFollowersCount,
                followerUserId: requesterId.toString(),
                followingCount: newFollowingCount,
            });
        }

        return res.status(200).json(new ApiResponse(200, {
            followedUser: {
                _id: userId,
                username: targetUser.username,
                fullName: targetUser.fullName,
                profileImageUrl: targetUser.profileImageUrl
            },
            isFollowing: true,
            isPending: false,
            followersCount: newFollowersCount ?? null,
            followingCount: newFollowingCount ?? null,
            timestamp: new Date()
        }, "Followed successfully"));
    }

    // If target user has private account, create or update follow request
    if (existingRequest) {
        // Update the existing request to pending (if it was rejected before)
        existingRequest.status = 'pending';
        existingRequest.createdAt = new Date();
        await existingRequest.save();
    } else {
        // Create new follow request
        await FollowRequest.create({ requesterId, recipientId: userId });
    }
    
    // Create notification for follow request
    await createFollowNotification({ recipientId: userId, sourceUserId: requesterId, isRequest: true });
    
    res.status(200).json(new ApiResponse(200, {
        targetUser: {
            _id: userId,
            username: targetUser.username,
            fullName: targetUser.fullName,
            profileImageUrl: targetUser.profileImageUrl
        },
        isFollowing: false,
        isPending: true,
        timestamp: new Date()
    }, "Follow request sent"));
}
catch(error){
    // console.log(error)
    return res.status(error.statusCode || 500).json(new ApiResponse(error.statusCode || 500, null, error.message || "An error occurred"));
}
});

// Unfollow a user or cancel follow request
export const unfollowUser = asyncHandler(async (req, res) => {
    try{

        const requesterId = req.user._id;
        const { userId } = req.body; // userId to unfollow
        
        // Check follow status: Redis first, DB fallback on miss or Redis down
        const isFollowing = await getFollowStatus(requesterId, userId);
        
        if (isFollowing) {
        // Write-through: DB + Redis in onUserUnfollowed
        const result = await onUserUnfollowed(requesterId, userId);

        const unfollowedUser = await User.findById(userId).select('username fullName profileImageUrl');

        let newFollowersCount = result.followersCount ?? null;
        let newFollowingCount = result.followingCount ?? null;

        if (!result.ok) {
            // DB delete inside onUserUnfollowed already failed — read fresh counts
            try {
                [newFollowersCount, newFollowingCount] = await Promise.all([
                    Follower.countDocuments({ userId }),
                    Follower.countDocuments({ followerId: requesterId }),
                ]);
            } catch { /* counts remain null */ }
        }
        
        // Cache invalidation fire-and-forget
        invalidateViewableUsersCache(requesterId).catch(() => {});
        invalidateViewableUsersCache(userId).catch(() => {});

        if (newFollowersCount !== null && newFollowingCount !== null) {
            socketManager.emitGlobal('follow_status_updated', {
                followedUserId: userId,
                followersCount: newFollowersCount,
                followerUserId: requesterId.toString(),
                followingCount: newFollowingCount,
            });
        }

        return res.status(200).json(new ApiResponse(200, {
            unfollowedUser: {
                _id: userId,
                username: unfollowedUser.username,
                fullName: unfollowedUser.fullName,
                profileImageUrl: unfollowedUser.profileImageUrl
            },
            isFollowing: false,
            isPending: false,
            followersCount: newFollowersCount ?? null,
            followingCount: newFollowingCount ?? null,
            timestamp: new Date()
        }, "Unfollowed successfully"));
    }
    
    // Check if there's a pending follow request to cancel
    const followRequest = await FollowRequest.findOneAndDelete({
        requesterId,
        recipientId: userId,
        status: 'pending'
    });

    if (followRequest) {
        const targetUser = await User.findById(userId).select('username fullName profileImageUrl');
        
        return res.status(200).json(new ApiResponse(200, {
            targetUser: {
                _id: userId,
                username: targetUser.username,
                fullName: targetUser.fullName,
                profileImageUrl: targetUser.profileImageUrl
            },
            isFollowing: false,
            isPending: false,
            timestamp: new Date()
        }, "Follow request cancelled"));
    }

    throw new ApiError(400, "Not following this user and no pending request found");
}
catch(error){
    // console.log(error)
    return res.status(error.statusCode || 500).json(new ApiResponse(error.statusCode || 500, null, error.message || "An error occurred"));
}
});

/**
 * A private account's social graph is part of what "private" promises.
 *
 * Both list endpoints used to take :userId straight from the params and return
 * the page, so any signed-in account could read the followers and following of
 * a private profile it had been refused — and of one that had blocked it —
 * even while GET /users/profile/other was telling the same caller the account
 * is private. checkContentVisibility covers all three questions: blocking in
 * either direction, the target's privacy flag, and whether the viewer is an
 * approved follower.
 */
const assertFollowListVisible = async (viewerId, targetUserId) => {
    if (viewerId?.toString() === targetUserId?.toString()) return;

    const canView = await checkContentVisibility(viewerId, targetUserId);
    if (!canView) {
        throw new ApiError(403, "This account is private");
    }

    // isFullPrivate is written alongside privacy by toggleFullPrivateAccount,
    // but checkContentVisibility only reads privacy — honour both.
    const target = await User.findById(targetUserId).select('isFullPrivate').lean();
    if (target?.isFullPrivate) {
        const isApprovedFollower = await Follower.exists({
            userId: targetUserId,
            followerId: viewerId
        });
        if (!isApprovedFollower) {
            throw new ApiError(403, "This account is private");
        }
    }
};

// Get followers of a user (Redis-first, paginated)
export const getFollowers = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    await assertFollowListVisible(req.user?._id, userId);

    // ── Total count ───────────────────────────────────────────────────────────
    const totalCount = await getFollowersCount(userId);

    // ── Cached IDs from Sorted Set (ZREVRANGE = newest-first) ────────────────
    const followersZSetKey = RedisKeys.userFollowers(userId);
    let cachedIds = [];
    try {
        const exists = await redisClient.exists(followersZSetKey);
        if (exists) {
            cachedIds = await redisClient.zrevrange(followersZSetKey, 0, FOLLOW_LIST_MAX - 1);
        } else {
            // Sorted Set expired — reseed from DB
            const dbTop = await Follower.find({ userId })
                .sort({ createdAt: -1 })
                .limit(FOLLOW_LIST_MAX)
                .select('followerId createdAt')
                .lean();
            if (dbTop.length) {
                const pipeline = redisClient.pipeline();
                dbTop.forEach(f => pipeline.zadd(
                    followersZSetKey,
                    new Date(f.createdAt).getTime(),
                    f.followerId.toString()
                ));
                pipeline.expire(followersZSetKey, LIST_TTL);
                await pipeline.exec();
                cachedIds = dbTop.map(f => f.followerId.toString());
            }
        }
    } catch {
        cachedIds = [];
    }

    let followerUsers = [];

    if (page === 1) {
        const cachedSlice = cachedIds.slice(0, limit);
        const remainderNeeded = limit - cachedSlice.length;

        let cachedUsers = [];
        if (cachedSlice.length) {
            const userDocs = await User.find({ _id: { $in: cachedSlice } })
                .select('username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            const userMap = new Map(userDocs.map(u => [u._id.toString(), u]));
            cachedUsers = cachedSlice.map(id => userMap.get(id)).filter(Boolean);
        }

        let dbUsers = [];
        if (remainderNeeded > 0) {
            const dbFollowers = await Follower.find({
                userId,
                followerId: { $nin: cachedIds },
            })
                .sort({ createdAt: -1 })
                .limit(remainderNeeded)
                .populate('followerId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            dbUsers = dbFollowers.map(f => f.followerId).filter(Boolean);
        }

        followerUsers = [...cachedUsers, ...dbUsers];
    } else {
        const page1Shown = Math.min(cachedIds.length, limit);
        const dbSkip = (limit - page1Shown) + (page - 2) * limit;

        const dbFollowers = await Follower.find({
            userId,
            followerId: { $nin: cachedIds },
        })
            .sort({ createdAt: -1 })
            .skip(dbSkip)
            .limit(limit)
            .populate('followerId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
            .lean();

        followerUsers = dbFollowers.map(f => f.followerId).filter(Boolean);
    }

    const followersWithBadges = await withViewerFollowState(await addBadgesToUsers(followerUsers), req.user?._id);
    const hasMore = page * limit < totalCount;

    res.status(200).json(new ApiResponse(200, {
        followers: followersWithBadges,
        totalCount,
        page,
        limit,
        hasMore,
    }, "Followers fetched successfully"));
});

// Get following of a user (Redis-first, paginated)
export const getFollowing = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    await assertFollowListVisible(req.user?._id, userId);

    // ── Total count ───────────────────────────────────────────────────────────
    const totalCount = await getFollowingCount(userId);

    // ── Cached IDs from Sorted Set ────────────────────────────────────────────
    const followingZSetKey = RedisKeys.userFollowing(userId);
    let cachedIds = [];
    try {
        const exists = await redisClient.exists(followingZSetKey);
        if (exists) {
            cachedIds = await redisClient.zrevrange(followingZSetKey, 0, FOLLOW_LIST_MAX - 1);
        } else {
            // Sorted Set expired — reseed from DB
            const dbTop = await Follower.find({ followerId: userId })
                .sort({ createdAt: -1 })
                .limit(FOLLOW_LIST_MAX)
                .select('userId createdAt')
                .lean();
            if (dbTop.length) {
                const pipeline = redisClient.pipeline();
                dbTop.forEach(f => pipeline.zadd(
                    followingZSetKey,
                    new Date(f.createdAt).getTime(),
                    f.userId.toString()
                ));
                pipeline.expire(followingZSetKey, LIST_TTL);
                await pipeline.exec();
                cachedIds = dbTop.map(f => f.userId.toString());
            }
        }
    } catch {
        cachedIds = [];
    }

    let followingUsers = [];

    if (page === 1) {
        const cachedSlice = cachedIds.slice(0, limit);
        const remainderNeeded = limit - cachedSlice.length;

        let cachedUsers = [];
        if (cachedSlice.length) {
            const userDocs = await User.find({ _id: { $in: cachedSlice } })
                .select('username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            const userMap = new Map(userDocs.map(u => [u._id.toString(), u]));
            cachedUsers = cachedSlice.map(id => userMap.get(id)).filter(Boolean);
        }

        let dbUsers = [];
        if (remainderNeeded > 0) {
            const dbFollowing = await Follower.find({
                followerId: userId,
                userId: { $nin: cachedIds },
            })
                .sort({ createdAt: -1 })
                .limit(remainderNeeded)
                .populate('userId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
                .lean();
            dbUsers = dbFollowing.map(f => f.userId).filter(Boolean);
        }

        followingUsers = [...cachedUsers, ...dbUsers];
    } else {
        const page1Shown = Math.min(cachedIds.length, limit);
        const dbSkip = (limit - page1Shown) + (page - 2) * limit;

        const dbFollowing = await Follower.find({
            followerId: userId,
            userId: { $nin: cachedIds },
        })
            .sort({ createdAt: -1 })
            .skip(dbSkip)
            .limit(limit)
            .populate('userId', 'username profileImageUrl fullName isVerified bio isBusinessProfile')
            .lean();

        followingUsers = dbFollowing.map(f => f.userId).filter(Boolean);
    }

    const followingWithBadges = await withViewerFollowState(await addBadgesToUsers(followingUsers), req.user?._id);
    const hasMore = page * limit < totalCount;

    res.status(200).json(new ApiResponse(200, {
        following: followingWithBadges,
        totalCount,
        page,
        limit,
        hasMore,
    }, "Following fetched successfully"));
});

// Approve follow request
export const approveFollowRequest = asyncHandler(async (req, res) => {
    const recipientId = req.user._id;
    const { requesterId } = req.body;

    // Find and update the follow request
    const followRequest = await FollowRequest.findOneAndUpdate(
        { requesterId, recipientId, status: 'pending' },
        { status: 'approved' },
        { new: true }
    );

    if (!followRequest) {
        throw new ApiError(404, "Follow request not found");
    }

    // Write-through: DB + Redis in onUserFollowed
    await onUserFollowed(requesterId, recipientId);

    // Create notification for approval
    await createFollowNotification({ recipientId: requesterId, sourceUserId: recipientId, isApproval: true });

    // Get requester info
    const requester = await User.findById(requesterId).select('username fullName profileImageUrl');

    res.status(200).json(new ApiResponse(200, {
        requester: {
            _id: requesterId,
            username: requester.username,
            fullName: requester.fullName,
            profileImageUrl: requester.profileImageUrl
        },
        isApproved: true,
        timestamp: new Date()
    }, "Follow request approved"));
});

// Reject follow request
export const rejectFollowRequest = asyncHandler(async (req, res) => {
    const recipientId = req.user._id;
    const { requesterId } = req.body;

    // Find and update the follow request
    const followRequest = await FollowRequest.findOneAndUpdate(
        { requesterId, recipientId, status: 'pending' },
        { status: 'rejected' },
        { new: true }
    );

    if (!followRequest) {
        throw new ApiError(404, "Follow request not found");
    }

    // Get requester info
    const requester = await User.findById(requesterId).select('username fullName profileImageUrl');

    res.status(200).json(new ApiResponse(200, {
        requester: {
            _id: requesterId,
            username: requester.username,
            fullName: requester.fullName,
            profileImageUrl: requester.profileImageUrl
        },
        isRejected: true,
        timestamp: new Date()
    }, "Follow request rejected"));
});

// Get pending follow requests for the current user
export const getPendingFollowRequests = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const requests = await FollowRequest.find({
        recipientId: userId,
        status: 'pending'
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('requesterId', 'username fullName profileImageUrl');

    const totalRequests = await FollowRequest.countDocuments({
        recipientId: userId,
        status: 'pending'
    });

    // Add badges to requesters
    const requestsWithBadges = await addBadgesToUsers(requests.map(req => req.requesterId));
    const requestersMap = new Map(requestsWithBadges.map(user => [user._id.toString(), user]));

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            requester: requestersMap.get(req.requesterId._id.toString()) || req.requesterId,
            timestamp: req.createdAt
        })),
        pagination: {
            totalRequests,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / limit),
            requestsPerPage: parseInt(limit)
        }
    }, "Pending follow requests retrieved"));
});

// Get sent follow requests for the current user
export const getSentFollowRequests = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const requests = await FollowRequest.find({
        requesterId: userId,
        status: 'pending'
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('recipientId', 'username fullName profileImageUrl');

    const totalRequests = await FollowRequest.countDocuments({
        requesterId: userId,
        status: 'pending'
    });

    // Add badges to recipients
    const recipientsWithBadges = await addBadgesToUsers(requests.map(req => req.recipientId));
    const recipientsMap = new Map(recipientsWithBadges.map(user => [user._id.toString(), user]));

    res.status(200).json(new ApiResponse(200, {
        requests: requests.map(req => ({
            _id: req._id,
            recipient: recipientsMap.get(req.recipientId._id.toString()) || req.recipientId,
            timestamp: req.createdAt
        })),
        pagination: {
            totalRequests,
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalRequests / limit),
            requestsPerPage: parseInt(limit)
        }
    }, "Sent follow requests retrieved"));
});
