import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyAdminJWT, requirePermission } from "../middlewares/adminAuth.middleware.js";
import { feedbackRateLimit } from "../middlewares/rateLimiter.middleware.js";
import {
    submitFeedback,
    getAllFeedback,
    updateFeedbackStatus,
    deleteFeedback
} from "../controllers/feedback.controllers.js";

const router = Router();

// ========== USER ROUTES ==========

// Submit feedback (authenticated users only)
router.post("/submit", verifyJWT, feedbackRateLimit, submitFeedback);

// ========== ADMIN ROUTES ==========
// Support requests carry the user's email and message, so they sit behind the
// same permission as user management rather than being open to every admin.

// Get all feedback (admin only)
router.get("/admin/all", verifyAdminJWT, requirePermission('manageUsers'), getAllFeedback);

// Move a request between open / in progress / resolved (admin only)
router.put("/admin/:feedbackId/status", verifyAdminJWT, requirePermission('manageUsers'), updateFeedbackStatus);

// Delete feedback (admin only)
router.delete("/admin/:feedbackId", verifyAdminJWT, requirePermission('manageUsers'), deleteFeedback);

export default router;
