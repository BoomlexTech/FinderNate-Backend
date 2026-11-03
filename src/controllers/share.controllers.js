import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Post from "../models/userPost.models.js";
import Like from "../models/like.models.js";
import PostInteraction from "../models/postInteraction.models.js";
import Follower from "../models/follower.models.js";
import { canViewPost } from "../utils/postPrivacy.js";
import {
  canSharePost,
  generatePreviewHTML,
  sanitizePostForGuest,
  generateErrorHTML,
} from "../utils/shareUtils.js";
import { redisClient, RedisKeys, RedisTTL } from "../config/redis.config.js";
// A share URL is permanent by nature — it lives in somebody else's chat long
// after the post is gone. Answering 404 made every one of those links look
// broken, so a deleted post now resolves to an explicit tombstone instead.
import { sendDeletedTombstone, buildDeletedTombstone } from "../utils/contentTombstone.utils.js";
import { batchIsLikedByUser } from "../utils/postEngagement.utils.js";
import { createPostVisibilityChecker } from "./post/visibility.js";

/**
 * Second gate behind canViewPost, which only knows about `isFullPrivate`.
 *
 * `privacy` and `isFullPrivate` are two separate schema fields, and an author
 * who is private by `privacy` alone fell straight through canViewPost's "post
 * is public, show it" branch — on an endpoint that answers anonymous callers.
 * Mirrors filterPostsByAccountPrivacy in post/read.controllers.js: the viewer
 * must be the author, or follow / be followed by them.
 */
const assertAuthorAccountVisible = (post, viewer, viewerFollowing, viewerFollowers, message) => {
  const author = post.userId;
  if (!author) return;

  const isPrivateAuthor = author.privacy === "private" || author.isFullPrivate === true;
  if (!isPrivateAuthor) return;

  const authorId = (author._id ?? author).toString();
  if (viewer && authorId === viewer._id.toString()) return;

  const related =
    !!viewer &&
    (viewerFollowing.includes(authorId) || viewerFollowers.includes(authorId));

  if (!related) throw new ApiError(403, message);
};

/**
 * Generate shareable link for a post
 * POST /api/v1/share/post/:postId/generate
 * Authentication: Required
 */
export const generatePostShareLink = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const userId = req.user._id;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Find post with user details
  const post = await Post.findById(postId).populate(
    "userId",
    "username fullName profileImageUrl"
  );

  if (!post) {
    // 410 with the marker rather than 404: the caller is looking at a card for a
    // post that has since been deleted, and "deleted by the owner" is the honest
    // answer to "give me a link to this".
    return sendDeletedTombstone(res, { contentType: "post", contentId: postId, status: 410 });
  }

  // Check if post can be shared
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Verify user can access this post (owner or post is public)
  const isOwner = post.userId._id.toString() === userId.toString();
  if (!isOwner && post.settings?.privacy !== "public") {
    throw new ApiError(403, "You don't have permission to share this post");
  }

  // Generate shareable link
  const shareLink = `https://findernate.com/r/${postId}`;

  // Prepare preview data
  const previewData = {
    shareLink,
    postType: post.postType,
    contentType: post.contentType,
    preview: {
      caption: post.caption
        ? post.caption.substring(0, 200) + (post.caption.length > 200 ? "..." : "")
        : null,
      thumbnailUrl: post.media?.[0]?.thumbnailUrl || post.media?.[0]?.url,
      author: {
        username: post.userId.username,
        fullName: post.userId.fullName,
        profileImageUrl: post.userId.profileImageUrl,
      },
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(200, previewData, "Share link generated successfully")
    );
});

/**
 * Generate shareable link for a reel
 * POST /api/v1/share/reel/:postId/generate
 * Authentication: Required
 */
export const generateReelShareLink = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const userId = req.user._id;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // Find post with user details
  const post = await Post.findById(postId).populate(
    "userId",
    "username fullName profileImageUrl"
  );

  if (!post) {
    // See generatePostShareLink — same reasoning, reel wording.
    return sendDeletedTombstone(res, { contentType: "reel", contentId: postId, status: 410 });
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    throw new ApiError(400, "This post is not a reel or video");
  }

  // Check if post can be shared
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Verify user can access this post (owner or post is public)
  const isOwner = post.userId._id.toString() === userId.toString();
  if (!isOwner && post.settings?.privacy !== "public") {
    throw new ApiError(403, "You don't have permission to share this reel");
  }

  // Generate shareable link
  const shareLink = `https://findernate.com/r/${postId}`;

  // Prepare preview data with video-specific metadata
  const previewData = {
    shareLink,
    postType: post.postType,
    contentType: post.contentType,
    preview: {
      caption: post.caption
        ? post.caption.substring(0, 200) + (post.caption.length > 200 ? "..." : "")
        : null,
      thumbnailUrl: post.media?.[0]?.thumbnailUrl || post.media?.[0]?.url,
      videoUrl: post.media?.[0]?.url,
      duration: post.media?.[0]?.duration,
      dimensions: post.media?.[0]?.dimensions,
      author: {
        username: post.userId.username,
        fullName: post.userId.fullName,
        profileImageUrl: post.userId.profileImageUrl,
      },
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(200, previewData, "Share link generated successfully")
    );
});

/**
 * Get shared post (public endpoint for guests)
 * GET /api/v1/share/post/:postId
 * Authentication: Optional (optionalVerifyJWT)
 */
export const getSharedPost = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const viewer = req.user || null;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  const cacheKey = `fn:share:post:${postId}`;

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl privacy isFullPrivate")
    .lean();

  if (!post) {
    // 200, not 404. This is the endpoint behind every shared /r/:postId link, and
    // a 404 here is indistinguishable from a mistyped URL — which is exactly what
    // produced the blank screen a recipient saw when the author deleted the post.
    //
    // Nothing about the post is disclosed: only that it existed and is gone.
    return sendDeletedTombstone(res, { contentType: "post", contentId: postId });
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Get viewer's following/followers lists if viewer is authenticated
  let viewerFollowing = [];
  let viewerFollowers = [];

  if (viewer) {
    // Check if viewer is blocked by post owner or vice versa
    const Block = mongoose.model("Block");
    const blockExists = await Block.findOne({
      $or: [
        { blockerId: post.userId._id, blockedId: viewer._id },
        { blockerId: viewer._id, blockedId: post.userId._id },
      ],
    });

    if (blockExists) {
      throw new ApiError(404, "Post not found");
    }

    const followingRecords = await Follower.find({
      followerId: viewer._id,
    }).lean();
    const followerRecords = await Follower.find({ userId: viewer._id }).lean();

    viewerFollowing = followingRecords.map((f) => f.userId.toString());
    viewerFollowers = followerRecords.map((f) => f.followerId.toString());
  }

  // Check privacy using existing privacy utility
  const canView = canViewPost(
    post,
    post.userId,
    viewer,
    viewerFollowing,
    viewerFollowers
  );

  if (!canView) {
    if (!viewer) {
      throw new ApiError(
        403,
        "This post is private. Please sign in to view if you have permission."
      );
    } else {
      throw new ApiError(403, "You don't have permission to view this post");
    }
  }

  assertAuthorAccountVisible(
    post,
    viewer,
    viewerFollowing,
    viewerFollowers,
    "This account is private. Follow to see their posts."
  );

  // Cache is read only AFTER the block check and the privacy gate above.
  //
  // It used to be read first, and the key holds nothing about the viewer — so
  // the moment one permitted viewer opened a share link, the next five minutes
  // of requests were answered from that entry without any authorization at
  // all: anonymous callers, and users the author had blocked, both got the
  // post body and media back.
  const cachedData = await redisClient.get(cacheKey);
  if (cachedData) {
    const parsed = JSON.parse(cachedData);
    if (viewer) {
      const likedSet = await batchIsLikedByUser(viewer._id, [postId]);
      parsed.post.isLikedBy = likedSet.has(postId.toString());
    }
    return res
      .status(200)
      .json(new ApiResponse(200, parsed, "Post fetched from cache"));
  }

  if (viewer) {
    const likedSet = await batchIsLikedByUser(viewer._id, [postId]);
    post.isLikedBy = likedSet.has(postId.toString());
  }

  // Get top 3 users who liked
  const topLikes = await Like.find({ postId })
    .populate("userId", "username fullName profileImageUrl")
    .limit(3)
    .lean();
  post.likedBy = topLikes.map((like) => like.userId);

  // Sanitize post data for guests
  const sanitizedPost = sanitizePostForGuest(post, viewer);

  const responseData = {
    post: sanitizedPost,
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: post.settings?.allowShares !== false,
      viewerCanInteract: !!viewer,
    },
  };

  // Cache the response for 5 minutes (300 seconds)
  // Don't cache viewer-specific fields
  const cacheData = {
    post: sanitizePostForGuest(post, null),
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: post.settings?.allowShares !== false,
      viewerCanInteract: false,
    },
  };
  await redisClient.setex(cacheKey, 300, JSON.stringify(cacheData));

  return res
    .status(200)
    .json(new ApiResponse(200, responseData, "Post fetched successfully"));
});

/**
 * Get shared reel (public endpoint for guests)
 * GET /api/v1/share/reel/:postId
 * Authentication: Optional (optionalVerifyJWT)
 */
export const getSharedReel = asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const viewer = req.user || null;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  const cacheKey = `fn:share:reel:${postId}`;

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl privacy isFullPrivate")
    .lean();

  if (!post) {
    // See getSharedPost — 200 with an explicit marker, reel wording.
    return sendDeletedTombstone(res, { contentType: "reel", contentId: postId });
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    throw new ApiError(400, "This content is not a reel or video");
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }

  // Get viewer's following/followers lists if viewer is authenticated
  let viewerFollowing = [];
  let viewerFollowers = [];

  if (viewer) {
    // Check if viewer is blocked by post owner or vice versa
    const Block = mongoose.model("Block");
    const blockExists = await Block.findOne({
      $or: [
        { blockerId: post.userId._id, blockedId: viewer._id },
        { blockerId: viewer._id, blockedId: post.userId._id },
      ],
    });

    if (blockExists) {
      throw new ApiError(404, "Reel not found");
    }

    const followingRecords = await Follower.find({
      followerId: viewer._id,
    }).lean();
    const followerRecords = await Follower.find({ userId: viewer._id }).lean();

    viewerFollowing = followingRecords.map((f) => f.userId.toString());
    viewerFollowers = followerRecords.map((f) => f.followerId.toString());
  }

  // Check privacy using existing privacy utility
  const canView = canViewPost(
    post,
    post.userId,
    viewer,
    viewerFollowing,
    viewerFollowers
  );

  if (!canView) {
    if (!viewer) {
      throw new ApiError(
        403,
        "This reel is private. Please sign in to view if you have permission."
      );
    } else {
      throw new ApiError(403, "You don't have permission to view this reel");
    }
  }

  assertAuthorAccountVisible(
    post,
    viewer,
    viewerFollowing,
    viewerFollowers,
    "This account is private. Follow to see their reels."
  );

  // Cache is read only AFTER the block check and the privacy gate above — see
  // getSharedPost for why reading it first handed the reel to anyone.
  const cachedData = await redisClient.get(cacheKey);
  if (cachedData) {
    const parsed = JSON.parse(cachedData);
    if (viewer) {
      const likedSet = await batchIsLikedByUser(viewer._id, [postId]);
      parsed.post.isLikedBy = likedSet.has(postId.toString());
    }
    return res
      .status(200)
      .json(new ApiResponse(200, parsed, "Reel fetched from cache"));
  }

  if (viewer) {
    const likedSet = await batchIsLikedByUser(viewer._id, [postId]);
    post.isLikedBy = likedSet.has(postId.toString());
  }

  // Get top 3 users who liked
  const topLikes = await Like.find({ postId })
    .populate("userId", "username fullName profileImageUrl")
    .limit(3)
    .lean();
  post.likedBy = topLikes.map((like) => like.userId);

  // Sanitize post data for guests
  const sanitizedPost = sanitizePostForGuest(post, viewer);

  const responseData = {
    post: sanitizedPost,
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: post.settings?.allowShares !== false,
      viewerCanInteract: !!viewer,
    },
  };

  // Cache the response for 5 minutes (300 seconds)
  const cacheData = {
    post: sanitizePostForGuest(post, null),
    shareMetadata: {
      shareUrl: `https://findernate.com/r/${postId}`,
      canShare: post.settings?.allowShares !== false,
      viewerCanInteract: false,
    },
  };
  await redisClient.setex(cacheKey, 300, JSON.stringify(cacheData));

  return res
    .status(200)
    .json(new ApiResponse(200, responseData, "Reel fetched successfully"));
});

/**
 * Get post preview page with Open Graph meta tags
 * GET /api/v1/share/post/:postId/preview
 * Authentication: None
 */
export const getPostPreviewPage = asyncHandler(async (req, res) => {
  const { postId } = req.params;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return res.status(404).type("html").send(generateErrorHTML("Invalid post ID"));
  }

  const cacheKey = `fn:share:preview:${postId}`;

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl")
    .lean();

  if (!post) {
    // 200, not 404: this page IS the answer to a link somebody followed, and the
    // deleted state is a real, renderable outcome rather than an error. The
    // "Post Not Found" wording is replaced with the tombstone sentence so the
    // recipient reads the same thing here as in the app.
    //
    // The private-account and sharing-disabled branches BELOW keep their 403/404
    // — those hide a post that still exists and must not start announcing it.
    const { message } = buildDeletedTombstone({ contentType: "post", contentId: postId });
    return res.status(200).type("html").send(generateErrorHTML(message));
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    const errorHTML = generateErrorHTML(shareCheck.reason);
    return res.status(403).type("html").send(errorHTML);
  }

  // This page carries no authentication, so the only viewer it can serve is an
  // anonymous one — which means the author's account has to be public.
  //
  // canSharePost only reads the POST-level privacy flag, and switching an
  // account to private deliberately does not rewrite that flag on existing
  // posts, so every post made before the switch still read "public" here and
  // was served — with the raw CDN URL in the og:image tag — to anyone holding
  // the id, including accounts the author had blocked.
  const isPubliclyViewable = await createPostVisibilityChecker(null)(post);
  if (!isPubliclyViewable) {
    const errorHTML = generateErrorHTML("Post Not Found");
    return res.status(404).type("html").send(errorHTML);
  }

  // Cache is read only after the checks above, so turning an account private
  // takes effect on the next request rather than ten minutes later.
  const cachedHTML = await redisClient.get(cacheKey);
  if (cachedHTML) {
    return res.status(200).type("html").send(cachedHTML);
  }

  // Generate preview HTML
  const htmlContent = generatePreviewHTML(post, "post");

  // Cache for 10 minutes (600 seconds)
  await redisClient.setex(cacheKey, 600, htmlContent);

  return res.status(200).type("html").send(htmlContent);
});

/**
 * Get reel preview page with Open Graph meta tags
 * GET /api/v1/share/reel/:postId/preview
 * Authentication: None
 */
export const getReelPreviewPage = asyncHandler(async (req, res) => {
  const { postId } = req.params;

  // Validate postId
  if (!mongoose.Types.ObjectId.isValid(postId)) {
    return res.status(404).type("html").send(generateErrorHTML("Invalid reel ID"));
  }

  const cacheKey = `fn:share:preview:reel:${postId}`;

  // Find post with user details
  const post = await Post.findById(postId)
    .populate("userId", "username fullName profileImageUrl")
    .lean();

  if (!post) {
    // See getPostPreviewPage — 200 with the tombstone sentence, reel wording.
    const { message } = buildDeletedTombstone({ contentType: "reel", contentId: postId });
    return res.status(200).type("html").send(generateErrorHTML(message));
  }

  // Verify it's a reel or video
  if (post.postType !== "reel" && post.postType !== "video") {
    const errorHTML = generateErrorHTML("This content is not a reel or video");
    return res.status(400).type("html").send(errorHTML);
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    const errorHTML = generateErrorHTML(shareCheck.reason);
    return res.status(403).type("html").send(errorHTML);
  }

  // Anonymous page — the author's account has to be public. See
  // getPostPreviewPage for why canSharePost alone is not enough.
  const isPubliclyViewable = await createPostVisibilityChecker(null)(post);
  if (!isPubliclyViewable) {
    const errorHTML = generateErrorHTML("Reel Not Found");
    return res.status(404).type("html").send(errorHTML);
  }

  // Cache is read only after the checks above.
  const cachedHTML = await redisClient.get(cacheKey);
  if (cachedHTML) {
    return res.status(200).type("html").send(cachedHTML);
  }

  // Generate preview HTML
  const htmlContent = generatePreviewHTML(post, "reel");

  // Cache for 10 minutes (600 seconds)
  await redisClient.setex(cacheKey, 600, htmlContent);

  return res.status(200).type("html").send(htmlContent);
});

/**
 * Track share event
 * POST /api/v1/share/track
 * Authentication: Required
 */
export const trackShare = asyncHandler(async (req, res) => {
  const { postId, platform, referrer } = req.body;
  const userId = req.user._id;

  // Validate postId
  if (!postId || !mongoose.Types.ObjectId.isValid(postId)) {
    throw new ApiError(400, "Invalid post ID");
  }

  // IP-based rate limit: max 5 shares per IP per postId per day
  const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const ipLimitKey = RedisKeys.shareIpLimit(ip, postId);
  const ipShareCount = await redisClient.incr(ipLimitKey);
  if (ipShareCount === 1) {
    await redisClient.expire(ipLimitKey, RedisTTL.SHARE_IP_LIMIT);
  }
  if (ipShareCount > 5) {
    throw new ApiError(429, "Share limit reached. You can share this post up to 5 times per day.");
  }

  // Find post
  const post = await Post.findById(postId);

  if (!post) {
    // Nothing to count a share against. 410 with the marker so the client shows
    // "deleted by the owner" rather than a bare failure on the share sheet.
    return sendDeletedTombstone(res, { contentType: "post", contentId: postId, status: 410 });
  }

  // Check if sharing is allowed
  const shareCheck = canSharePost(post);
  if (!shareCheck.canShare) {
    throw new ApiError(403, shareCheck.reason);
  }
  let shareCount;
  try {
    const results = await redisClient
      .multi()
      .incr(RedisKeys.postShareCount(postId))
      .expire(RedisKeys.postShareCount(postId), RedisTTL.SHARE_COUNT)
      .exec();
    shareCount = results?.[0] ?? null;
  } catch (_) {
    
  }

  if (shareCount == null) {
    const updated = await Post.findByIdAndUpdate(
      postId,
      { $inc: { "engagement.shares": 1 } },
      { new: true }
    ).select("engagement.shares");
    shareCount = updated?.engagement?.shares ?? 0;
  }

  // Create PostInteraction record
  await PostInteraction.create({
    userId,
    postId,
    interactionType: "share",
    lastInteracted: new Date(),
  });

  // No per-share analytics row is written. This used to $push
  // {userId, platform, referrer, userAgent} onto "analytics.shareEvents",
  // a path AnalyticsSchema does not declare, so Mongoose strict mode dropped
  // the whole update — it recorded nothing, and would have started collecting
  // user-agent/referrer fingerprints the moment the field was added. The share
  // COUNT is still tracked above (Redis, and engagement.shares as fallback).

  // Invalidate share-page cache
  await redisClient.del(`fn:share:post:${postId}`);
  await redisClient.del(`fn:share:reel:${postId}`);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        shareCount,
        shareUrl: `https://findernate.com/r/${postId}`,
      },
      "Share tracked successfully"
    )
  );
});
