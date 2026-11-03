import { Router } from "express";
import { optionalVerifyJWT, verifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { getSuggestedForYou, dismissSuggestion } from "../controllers/suggestedForYou.controllers.js";

const router = Router();

// Get suggested for you (all suggestions combined)
router.get("/suggested-for-you", optionalVerifyJWT, getBlockedUsersMiddleware, getSuggestedForYou);

// Hide one suggested account for 30 days (Phase 2 #5)
router.post("/dismiss", verifyJWT, dismissSuggestion);

export default router; 