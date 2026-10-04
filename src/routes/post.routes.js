// routes/post.routes.js
import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { MAX_IMAGES_PER_POST, MAX_VIDEOS_PER_POST } from "../constants/uploadLimits.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { verifyAdminJWT } from "../middlewares/adminAuth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { cacheUserFeed } from "../middlewares/cache.middleware.js";
import { requirePostQuota, batchPostCount } from "../middlewares/subscription.middleware.js";
import {
    createNormalPost,
    createTweetPost,
    createProductPost,
    createServicePost,
    createBusinessPost,
    createBatchPosts,
    getUserProfilePosts,
    getMyPosts,
    getPostById,
    deleteContent,
    editPost,
    togglePostPrivacy,
} from "../controllers/post.controllers.js";
import { getHomeFeed } from "../controllers/homeFeed.controllers.js";
import { likePost, unlikePost, likeComment, unlikeComment, getLikedByUsers } from "../controllers/like.controllers.js";
import { createComment, getCommentsByPost, getCommentById, updateComment, deleteComment } from "../controllers/comment.controllers.js";
import { getNotifications, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification } from "../controllers/notification.controllers.js";
import { getProfileTabContent } from "../controllers/switch.controllers.js";
import { savePost, unsavePost, getSavedPosts, checkPostSaved } from "../controllers/savePost.controllers.js";
import { reportContent, getReports, updateReportStatus } from "../controllers/report.controllers.js";
import { trackPostInteraction, hidePost, batchTrackInteractions, getUserInteractionHistory } from "../controllers/postInteraction.controllers.js";
import { getOnlineStoreProducts } from "../controllers/onlineStoreProducts.controllers.js";


const router = Router();

// Accept image or video from frontend.
//
// One video per field, ten images. These counts are the memory guard: multer
// buffers every file in RAM, so ten 600 MB videos in one request would be
// several GB before a controller ever runs. The total across the video-ish
// fields is enforced in uploadPostMedia, since a per-field maxCount cannot see
// that "video", "reel" and "story" all merge into the same media array.
const mediaUpload = upload.fields([
    { name: "image", maxCount: MAX_IMAGES_PER_POST },
    { name: "video", maxCount: MAX_VIDEOS_PER_POST },
    { name: "reel", maxCount: MAX_VIDEOS_PER_POST },
    { name: "story", maxCount: MAX_VIDEOS_PER_POST },
    { name: "thumbnail", maxCount: 1 },
]);

// requirePostQuota (Free business accounts: monthly post cap) must stay after
// verifyJWT and before the controller, so a refused request uploads nothing.
// Any new route that creates a Post has to carry it too.
router.route("/create/normal").post(mediaUpload, verifyJWT, requirePostQuota(), createNormalPost);
router.route("/create/tweet").post(mediaUpload, verifyJWT, requirePostQuota(), createTweetPost);
router.route("/create/service").post(mediaUpload, verifyJWT, requirePostQuota(), createServicePost);
router.route("/create/product").post(mediaUpload, verifyJWT, requirePostQuota(), createProductPost);
router.route("/create/business").post(mediaUpload, verifyJWT, requirePostQuota(), createBusinessPost);

// Batch post creation - up to 6 posts at once with mixed content types
const batchMediaUpload = upload.fields(
    Array.from({ length: 6 }, (_, i) => [
        { name: `post_${i}_image`, maxCount: MAX_IMAGES_PER_POST },
        { name: `post_${i}_video`, maxCount: MAX_VIDEOS_PER_POST },
        { name: `post_${i}_thumbnail`, maxCount: 1 },
    ]).flat()
);
router.route("/create/batch").post(batchMediaUpload, verifyJWT, requirePostQuota(batchPostCount), createBatchPosts);
router.route("/user/:userId/profile").get(verifyJWT, getUserProfilePosts);
// Viewing a profile's tabs is browsing, so a signed-out visitor may do it —
// but only now that getProfileTabContent actually enforces privacy. Until
// this commit it filtered on userId alone, and verifyJWT was doing the entire
// job of "who may see this", which it cannot: being signed in is not the same
// as being allowed. checkContentVisibility now covers blocking, the target's
// privacy setting and own-content, and takes a null viewer.
router.route("/switch/profile/:userId").get(optionalVerifyJWT, getProfileTabContent);
router.route("/home-feed").get(optionalVerifyJWT, getBlockedUsersMiddleware, getHomeFeed);
router.route("/myPosts").get(verifyJWT, getMyPosts);
router.route("/notifications").get(verifyJWT, getNotifications);


// Like/unlike post
router.route("/like").post(verifyJWT, likePost);
router.route("/unlike").post(verifyJWT, unlikePost);

// Like/unlike comment
router.route("/like-comment").post(verifyJWT, likeComment);
router.route("/unlike-comment").post(verifyJWT, unlikeComment);

// Comment routes
router.route("/comment").post(verifyJWT, createComment);
// READING comments is public, like the feed those comments hang off.
//
// These were verifyJWT, so a signed-out visitor got 401 and the sheet opened
// empty — while the post card beside it read "2 comments", because the count
// comes from engagement.comments in the public feed payload. The feed already
// returns comment CONTENT to guests too, so requiring a token here protected
// nothing; it only made the app contradict itself.
//
// Both controllers already do `req.user?._id ? ... : null`, i.e. they were
// written for optional auth from the start — only the middleware disagreed.
// Writing a comment stays behind verifyJWT below.
router.route("/comments").get(optionalVerifyJWT, getCommentsByPost);
router.route("/comment/:commentId").get(optionalVerifyJWT, getCommentById);
router.route("/comment/:commentId").put(verifyJWT, updateComment);
router.route("/comment/:commentId").delete(verifyJWT, deleteComment);

// Save post routes (Instagram-style: Always private, only visible to owner)
router.route("/save").post(verifyJWT, savePost);
router.route("/save/:postId").delete(verifyJWT, unsavePost);
router.route("/saved").get(verifyJWT, getSavedPosts);
router.route("/saved/check/:postId").get(verifyJWT, checkPostSaved);

// Report routes
//
// Filing a report is something any signed-in user does. READING the reports and
// changing their status are moderation actions and were sitting behind plain
// verifyJWT — so any authenticated account could enumerate every report on the
// platform (who reported whom, and why) and mark any of them resolved or
// dismissed, quietly clearing complaints about their own content.
router.route("/report").post(verifyJWT, reportContent);
router.route("/reports").get(verifyAdminJWT, getReports);
router.route("/report/:reportId/status").put(verifyAdminJWT, updateReportStatus);

// Interaction tracking routes
router.route("/interaction/track").post(verifyJWT, trackPostInteraction);
router.route("/interaction/batch").post(verifyJWT, batchTrackInteractions);
router.route("/interaction/hide").post(verifyJWT, hidePost);
router.route("/interaction/history").get(verifyJWT, getUserInteractionHistory);

// Edit post route
router.route("/edit/:postId").put(verifyJWT, editPost);

// Toggle post privacy route
router.route("/:postId/privacy").put(verifyJWT, togglePostPrivacy);

// Online store — public, no auth required (must be before /:postId catch-all)
router.route("/online-store/products").get(getOnlineStoreProducts);

// Liked-by users list (must be before /:postId catch-all)
router.route("/liked-by").get(optionalVerifyJWT, getLikedByUsers);

// Common API - handles get and delete for posts, stories, and reels
router.route("/:postId").get(verifyJWT, getPostById).delete(verifyJWT, deleteContent);

// Notification routes
router.route("/notification").get(optionalVerifyJWT, getNotifications);
router.route("/notification/:notificationId/read").patch(verifyJWT, markNotificationAsRead);
router.route("/notification/read-all").patch(verifyJWT, markAllNotificationsAsRead);
router.route("/notification/:notificationId").delete(verifyJWT, deleteNotification);

export default router;
