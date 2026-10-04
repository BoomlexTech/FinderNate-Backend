import { Router } from "express";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { verifyAdminJWT } from "../middlewares/adminAuth.middleware.js";
import { upload } from "../middlewares/multerConfig.js";
import { generalRateLimit } from "../middlewares/rateLimiter.middleware.js";
import {
    switchTobusinessprofile,
    switchToPersonalAccount,
    createBusinessProfile,
    deleteBusinessProfile,
    selectBusinessPlan,
    getBusinessProfile,
    updateBusinessProfile,
    getBusinessById,
    getMyBusinessCategory,
    updateExistingActiveBusinesses,
    updateLiveLocation,
    toggleLiveLocation,
    getNearbyBusinesses,
    updateBusinessCategory,
    getBusinessCategories,
    rateBusiness,
    getBusinessRatingSummary,
    toggleProductPosts,
    toggleServicePosts,
    uploadVerificationDocument,
    addOrUpdateBankDetails,
    getBankDetails,
    deleteBankDetails,
    getBusinessInsights,
    getBusinessInsightsPosts,
    exportBusinessInsights
} from "../controllers/business.controllers.js";

const router = Router();

// Every route below is scoped to the signed-in user — each controller opens
// with `const userId = req.user._id`. They were on optionalVerifyJWT, which
// lets a request through WITHOUT setting req.user, so a logged-out caller got
// a 500 ("Cannot read properties of undefined") instead of a 401. That matters
// now the app opens in guest mode. For a valid token the two middlewares are
// identical, so signed-in behaviour is unchanged.

// Switch to business profile (checks if business exists or needs registration)
router.route("/switch-to-business").post(verifyJWT, switchTobusinessprofile);

// Switch to personal account from business account
router.route("/switch-to-personal").post(verifyJWT, switchToPersonalAccount);

// Create business profile
router.route("/create").post(verifyJWT, createBusinessProfile);

// Delete business profile
router.route("/delete").delete(verifyJWT, deleteBusinessProfile);

// Select business plan
router.route("/select-plan").post(verifyJWT, selectBusinessPlan);

// Get authenticated user's business profile
router.route("/profile").get(verifyJWT, getBusinessProfile);

// Update business profile (any plan can update)
router.route("/update").patch(verifyJWT, updateBusinessProfile);

// Update business category specifically (any plan can update)
router.route("/update-category").patch(verifyJWT, updateBusinessCategory);

// Get all available business categories (public access)
router.route("/categories").get(getBusinessCategories);

// Get my business category (auth required) - Must be before /:id route
router.route("/my-category").get(verifyJWT, getMyBusinessCategory);

// 📊 Insights - static paths, so they must stay above the /:id catch-all below
router.route("/insights").get(verifyJWT, generalRateLimit, getBusinessInsights);
router.route("/insights/posts").get(verifyJWT, generalRateLimit, getBusinessInsightsPosts);
router.route("/insights/export").get(verifyJWT, generalRateLimit, exportBusinessInsights);

// 📍 Live location endpoints
router.route("/live-location").patch(verifyJWT, updateLiveLocation);
router.route("/toggle-live-location").post(verifyJWT, toggleLiveLocation);
router.route("/nearby").get(getNearbyBusinesses);

// 📝 Post Settings Routes
router.route("/toggle-product-posts").post(verifyJWT, toggleProductPosts);
router.route("/toggle-service-posts").post(verifyJWT, toggleServicePosts);

// 📄 Document Upload Routes
// Single API: Upload file + Attach to business + Appears in admin panel
router.route("/upload-document").post(verifyJWT, upload.single("document"), uploadVerificationDocument);

// 🏦 Bank Details Routes
router.route("/bank-details").post(verifyJWT, upload.single("paymentQRCode"), addOrUpdateBankDetails);
router.route("/bank-details").get(verifyJWT, getBankDetails);
router.route("/bank-details").delete(verifyJWT, deleteBankDetails);

// Get business by ID (public access) - MUST be after all static routes to avoid catching them as :id
//
// optionalVerifyJWT so the controller can tell the owner apart from everyone
// else: the response hides bank details, Aadhaar and verification documents
// unless the caller owns the business.
router.route("/:id").get(optionalVerifyJWT, getBusinessById);

// 📊 Business Rating Routes
router.route("/:businessId/rate").post(verifyJWT, rateBusiness);
router.route("/:businessId/rating-summary").get(getBusinessRatingSummary);

// Helper route to update existing businesses with active subscriptions (admin only)
//
// It was "admin only" in the comment alone: optionalVerifyJWT admits callers
// with no token, and the controller never reads req.user, so ANYONE could POST
// here and run updateMany({subscriptionStatus:'active'}, {isVerified:true})
// across the whole collection. Nothing in the app or website calls it — it is
// a one-off migration helper — so it is now behind real admin auth.
router.route("/admin/update-active-businesses").post(verifyAdminJWT, updateExistingActiveBusinesses);

export default router; 