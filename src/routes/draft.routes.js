import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multerConfig.js";
import { MAX_IMAGES_PER_POST, MAX_VIDEOS_PER_POST } from "../constants/uploadLimits.js";
import { listDrafts, getDraft, createDraft, updateDraft, deleteDraft, uploadDraftMedia } from "../controllers/draft.controllers.js";

// Drafts for posts, vibes and notes (Phase 2 #70). Publish a draft by sending
// the normal create request with `draftId` and no files.
const router = Router();
const draftMediaUpload = upload.fields([
    { name: "image", maxCount: MAX_IMAGES_PER_POST },
    { name: "video", maxCount: MAX_VIDEOS_PER_POST },
    { name: "reel", maxCount: MAX_VIDEOS_PER_POST },
    { name: "thumbnail", maxCount: 1 },
]);
router.route("/").get(verifyJWT, listDrafts).post(verifyJWT, createDraft);
router.post("/media", draftMediaUpload, verifyJWT, uploadDraftMedia);
router.route("/:draftId").get(verifyJWT, getDraft).put(verifyJWT, updateDraft).delete(verifyJWT, deleteDraft);
export default router;
