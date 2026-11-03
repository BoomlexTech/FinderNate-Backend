import { Router } from "express";
import { optionalVerifyJWT, verifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { getSuggestedForYou, dismissSuggestion } from "../controllers/suggestedForYou.controllers.js";
import { getComposeSuggestions, suggestHashtagsForPost } from "../controllers/composeSuggestions.controllers.js";

const router = Router();

// Get suggested for you (all suggestions combined)
router.get("/suggested-for-you", optionalVerifyJWT, getBlockedUsersMiddleware, getSuggestedForYou);

// Hide one suggested account for 30 days (Phase 2 #5)
router.post("/dismiss", verifyJWT, dismissSuggestion);

// Suggestions while writing a post (#11) and hashtags for a caption (#45)
router.get("/compose", verifyJWT, getComposeSuggestions);
router.post("/hashtags", verifyJWT, suggestHashtagsForPost);

export default router; 