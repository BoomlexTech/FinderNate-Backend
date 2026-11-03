import express from "express";
import { getExploreFeed } from "../controllers/explore.controllers.js";
import { getTrendingTopicsHandler, getHashtagPosts, getTrendingNearYou } from "../controllers/trending.controllers.js";
import { optionalVerifyJWT } from "../middlewares/auth.middleware.js";
import { getBlockedUsers as getBlockedUsersMiddleware } from "../middlewares/blocking.middleware.js";

const router = express.Router();

// Explore is browsing, and browsing is open — the same rule the home feed
// already follows. This was verifyJWT, so a signed-out visitor opening the
// search tab got a 401 and "Failed to load products. Unauthorized request."
//
// Everything downstream was already written for an anonymous caller:
// getExploreFeed reads `req.user?._id`, getBlockedUsers returns an empty list
// when there is no user, and getViewableUserIds has an explicit `if (!viewerId)`
// branch limiting anonymous callers to public accounts. Only the middleware
// disagreed, and it turned a working guest path into a hard failure.
router.route("/").get(optionalVerifyJWT, getBlockedUsersMiddleware, getExploreFeed);

// Phase 2: trending topics (#58), a topic's posts, trending near you and hot deals (#42)
router.get("/trending-topics", getTrendingTopicsHandler);
router.get("/hashtag/:tag", optionalVerifyJWT, getBlockedUsersMiddleware, getHashtagPosts);
router.get("/trending-near-you", optionalVerifyJWT, getBlockedUsersMiddleware, getTrendingNearYou);

export default router;
