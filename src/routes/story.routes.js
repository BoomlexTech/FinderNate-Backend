import express from "express";
import { uploadStory, fetchStoriesFeed, fetchStoriesByUser, markStorySeen, fetchStoryViewers, fetchArchivedStoriesByUser, archiveStory, unarchiveStory, deleteStory } from "../controllers/story.controllers.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { likeStory, unlikeStory, getStoryLikes, commentOnStory, getStoryComments, deleteStoryComment, repostToStory } from "../controllers/storyEngagement.controllers.js";
import { respondToSticker, getStickerResults, replyToQuestion } from "../controllers/storyStickers.controllers.js";
import { upload } from "../middlewares/multerConfig.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";

const router = express.Router();

// Phase 2: share a post or vibe to your story (#56); likes and comments (#32).
// The owner can read likes and comments on archived stories too.
router.post("/repost", verifyJWT, repostToStory);
router.route("/:storyId/like").post(verifyJWT, likeStory).delete(verifyJWT, unlikeStory);
router.get("/:storyId/likes", verifyJWT, getStoryLikes);
router.route("/:storyId/comments").post(verifyJWT, commentOnStory).get(verifyJWT, getStoryComments);
router.delete("/:storyId/comments/:commentId", verifyJWT, deleteStoryComment);

// Phase 5 #47: poll, quiz, slider, countdown and question stickers.
router.post("/:storyId/stickers/:stickerId/respond", verifyJWT, respondToSticker);
router.get("/:storyId/stickers/results", verifyJWT, getStickerResults);
router.post("/:storyId/stickers/:stickerId/questions/:responseId/reply", verifyJWT, replyToQuestion);

// Upload a story (single image/video). Phase 5 adds the optional fields
// editId, music and stickers; see docs/PHASE5_API.md.

router.post("/upload", verifyJWT, upload.single("media"), uploadStory);

// Fetch stories feed (from followed + self)
router.get("/feed", verifyJWT, getBlockedUsersMiddleware, fetchStoriesFeed);

// Fetch stories by user id - allow both authenticated and unauthenticated users with privacy checks
router.get("/user/:userId", optionalVerifyJWT, getBlockedUsersMiddleware, fetchStoriesByUser);

// Mark story as seen
router.post("/seen", verifyJWT, getBlockedUsersMiddleware, markStorySeen);

// Fetch archived stories by user - allow both authenticated and unauthenticated users with privacy checks
router.get("/archived/:userId", optionalVerifyJWT, getBlockedUsersMiddleware, fetchArchivedStoriesByUser);

// Archive / un-archive a story — author only, and the only thing that ever
// sets isArchived. An archived story is exempt from the 24-hour purge job and
// is what GET /archived/:userId lists.
router.patch("/:storyId/archive", verifyJWT, archiveStory);
router.patch("/:storyId/unarchive", verifyJWT, unarchiveStory);

// Fetch viewers of a story
router.get("/:storyId/viewers", verifyJWT, fetchStoryViewers);

// Delete a story
router.delete("/:storyId", verifyJWT, deleteStory);

export default router;