import { Router } from "express";
import { upload } from "../middlewares/multerConfig.js";
import { verifyJWT, optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";
import { cacheSearchResults } from "../middlewares/cache.middleware.js";
import { authRateLimit, loginRateLimit } from "../middlewares/rateLimiter.middleware.js";
import { loginUser, logOutUser, registerUser, verifyRegistrationOTP, resendRegistrationOTP, getUserProfile, updateUserProfile, changePassword, deleteAccount, searchUsers, verifyEmailWithOTP, uploadProfileImage, sendVerificationOTPForEmail, sendPasswordResetOTP, resetPasswordWithOTP, getOtherUserProfile, checkTokenExpiry, togglePhoneNumberVisibility, toggleAddressVisibility, trackSearch, getPopularSearches, blockUser, unblockUser, getBlockedUsers, checkIfUserBlocked, getUsernameSuggestions, checkUsernameAvailability, toggleFullPrivateAccount, toggleServiceAutoFill, getPreviousServicePostData, toggleProductAutoFill, getPreviousProductPostData, saveFCMToken, testFCMNotification, checkFirebaseStatus, updateMessagingPrivacy, getMessagingPrivacy, sendPhoneVerificationOtp, verifyAndUpdatePhone, getOtpStatus, sendEmailChangeOtp, verifyAndUpdateEmail } from "../controllers/user.controllers.js";
import { getChatWallpaper, updateChatWallpaper } from "../controllers/user/chatWallpaper.js";
import { getWatchHistory, removeFromHistory, clearHistory, updateHistorySettings } from "../controllers/history.controllers.js";
import { getMyCategoryPreferences, updateMyCategoryPreferences, getNewPostRing } from "../controllers/discovery.controllers.js";
import { getActivitySettings, updateActivitySettings } from "../controllers/user/activitySettings.js";
import { getProfileVisitors } from "../controllers/profileVisitors.controllers.js";
import { searchAllContent } from "../controllers/searchAllContent.controllers.js";
import { followUser, unfollowUser, getFollowers, getFollowing, approveFollowRequest, rejectFollowRequest, getPendingFollowRequests, getSentFollowRequests } from "../controllers/follower.controllers.js";
import { getSearchSuggestions } from "../controllers/searchSuggestion.controllers.js";
import { instantSearch, searchProfiles, searchProducts } from "../controllers/search.controllers.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// THE CREDENTIAL ROUTES ARE RATE LIMITED PER IP.
//
// app.js applies generalRateLimit to everything, but that is 50,000 requests a
// minute — traffic shaping, not a limit an attacker would ever notice. Every
// route below that sends a code, checks a code, or checks a password carries
// its own limiter as well, mounted FIRST so a rejected request never reaches
// the controller (same order the payment routes use for
// guestCheckoutIpRateLimit).
//
// Two limiters, differing only in what they do when Redis is down:
//   authRateLimit  — OTP send + OTP verify. Fails CLOSED.
//   loginRateLimit — sign-in only. Fails OPEN, because the per-account
//                    failed-login throttle is the real control there and a
//                    cache blip must not take sign-in down platform-wide.
// See rateLimiter.middleware.js for the full reasoning on both.
// ─────────────────────────────────────────────────────────────────────────────
// ── Phase 2: the signed-in account's own activity ───────────────────────────
// Watch history (#14)
router.get("/me/history", verifyJWT, getWatchHistory);
router.delete("/me/history", verifyJWT, clearHistory);
router.patch("/me/history/settings", verifyJWT, updateHistorySettings);
router.delete("/me/history/:postId", verifyJWT, removeFromHistory);
// Category preferences (#26)
router.route("/me/categories").get(verifyJWT, getMyCategoryPreferences).put(verifyJWT, updateMyCategoryPreferences);
// Mentions, history pause, profile visits and email digest settings
router.route("/me/activity-settings").get(verifyJWT, getActivitySettings).patch(verifyJWT, updateActivitySettings);
// Profile visitors (#65) and the new-post ring (#55)
router.get("/me/profile-visitors", verifyJWT, getProfileVisitors);
router.get("/me/new-post-ring", verifyJWT, getNewPostRing);

router.route("/register").post(authRateLimit, registerUser);
router.route("/register/verify").post(authRateLimit, verifyRegistrationOTP);
router.route("/register/resend-otp").post(authRateLimit, resendRegistrationOTP);
router.route("/login").post(loginRateLimit, loginUser);
router.route("/logout").post(verifyJWT, logOutUser);
router.route("/profile").get(verifyJWT, getUserProfile);
router.route("/profile").put(verifyJWT, upload.single("profileImage"), updateUserProfile);
router.route("/profile/change-password").put(verifyJWT, changePassword);
router.route("/profile").delete(verifyJWT, deleteAccount);
router.route("/profile/search").get(verifyJWT, getBlockedUsersMiddleware, searchUsers);
router.route("/verify-email-otp").post(authRateLimit, verifyEmailWithOTP);
router.route("/send-verification-otp").post(authRateLimit, sendVerificationOTPForEmail);
router.route("/send-phone-verification-otp").post(authRateLimit, verifyJWT, sendPhoneVerificationOtp);
router.route("/verify-update-phone").post(authRateLimit, verifyJWT, verifyAndUpdatePhone);
// Changing the email address mirrors the phone flow: OTP to the NEW address,
// then verify. Nothing is written until the code checks out.
router.route("/send-email-change-otp").post(authRateLimit, verifyJWT, sendEmailChangeOtp);
// Alias: the website has been calling this path (and /verify-update-email)
// since before the handler existed, so those requests were 404ing and email
// changes silently failed there. Same handler, so both clients work and no
// already-deployed frontend needs to change.
router.route("/send-email-update-otp").post(authRateLimit, verifyJWT, sendEmailChangeOtp);
router.route("/verify-update-email").post(authRateLimit, verifyJWT, verifyAndUpdateEmail);
router.route("/profile/upload-image").post(verifyJWT, upload.single("profileImage"), uploadProfileImage);
router.route("/send-reset-otp").post(authRateLimit, sendPasswordResetOTP);
router.route("/reset-password").post(authRateLimit, resetPasswordWithOTP);
// Public — fetch OTP cooldown & expiry remaining (query: identifier, type, purpose)
router.route("/otp-status").get(getOtpStatus);
router.route("/check-token").post(checkTokenExpiry);
router.route("/searchAllContent").get(optionalVerifyJWT, getBlockedUsersMiddleware, cacheSearchResults, searchAllContent);
router.route("/profile/other").get(verifyJWT, getBlockedUsersMiddleware, getOtherUserProfile);

// Follower routes
router.post("/follow", verifyJWT, followUser);
router.post("/unfollow", verifyJWT, unfollowUser);
router.get("/followers/:userId", verifyJWT, getFollowers);
router.get("/following/:userId", verifyJWT, getFollowing);

// Follow request routes
router.post("/follow-request/approve", verifyJWT, approveFollowRequest);
router.post("/follow-request/reject", verifyJWT, rejectFollowRequest);
router.get("/follow-requests/pending", verifyJWT, getPendingFollowRequests);
router.get("/follow-requests/sent", verifyJWT, getSentFollowRequests);

// Search suggestion routes
router.get("/search-suggestions", verifyJWT, getSearchSuggestions);

// ⚡ Typesense-powered fast search (typo-tolerant, instant). optionalVerifyJWT so
// logged-out users can search too; getBlockedUsers filters blocked profiles when authed.
router.get("/search/instant", optionalVerifyJWT, getBlockedUsersMiddleware, instantSearch);
router.get("/search/profiles", optionalVerifyJWT, getBlockedUsersMiddleware, searchProfiles);
router.get("/search/products", optionalVerifyJWT, searchProducts);

// Search tracking routes
router.post("/track-search", trackSearch);
router.get("/popular-searches", getPopularSearches);


// Get other user profile by userId or username (already defined above with middleware)
// router.get("/profile/other", verifyJWT, getOtherUserProfile);

// Privacy settings routes
router.put("/privacy/phone-number", verifyJWT, togglePhoneNumberVisibility);
router.put("/privacy/address", verifyJWT, toggleAddressVisibility);
router.put("/privacy/account", verifyJWT, toggleFullPrivateAccount);
router.put("/privacy/full-private", verifyJWT, toggleFullPrivateAccount); // Alias for /privacy/account

// Block user routes
router.post("/block", verifyJWT, blockUser);
router.post("/unblock", verifyJWT, unblockUser);
router.get("/blocked-users", verifyJWT, getBlockedUsers);
router.get("/check-block/:userId", verifyJWT, checkIfUserBlocked);

// Username suggestion routes (real-time as user types)
router.get("/username-suggestions", getUsernameSuggestions);
router.get("/check-username", checkUsernameAvailability);

// Service post preferences routes
router.put("/service-post/toggle-autofill", verifyJWT, toggleServiceAutoFill);
router.get("/service-post/previous-data", verifyJWT, getPreviousServicePostData);

// Product post preferences routes
router.put("/product-post/toggle-autofill", verifyJWT, toggleProductAutoFill);
router.get("/product-post/previous-data", verifyJWT, getPreviousProductPostData);

// FCM token route (optional auth - saves token if authenticated, returns helpful message if not)
router.post("/fcm-token", optionalVerifyJWT, saveFCMToken);

// Firebase configuration status (for debugging)
router.get("/firebase-status", checkFirebaseStatus);

// Test FCM notification route
router.post("/test-fcm", verifyJWT, testFCMNotification);

// Messaging privacy routes
router.patch("/messaging/privacy", verifyJWT, updateMessagingPrivacy);

// Chat background wallpaper — one choice per user, applied to every
// conversation on both clients. Stored on the user, not the chat, so it does
// not alter what the other participant sees.
router.route("/chat-wallpaper")
    .get(verifyJWT, getChatWallpaper)
    .patch(verifyJWT, updateChatWallpaper);
router.get("/messaging/privacy", verifyJWT, getMessagingPrivacy);

export default router;