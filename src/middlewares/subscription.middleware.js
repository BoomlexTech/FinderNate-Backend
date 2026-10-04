import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.models.js";
import Subscription from "../models/subscription.models.js";
import { getPostQuota, getPostQuotaMode, buildPostLimitError } from "../utils/planLimits.js";

/**
 * Monthly post cap for Free business accounts.
 *
 * Mount AFTER verifyJWT (and after multer on the create routes, so that a batch's
 * `req.body.posts` has been parsed). Runs before the controller, so a blocked
 * request never uploads media to Bunny. `countFn(req)` says how many posts this
 * request would create; the default is one.
 *
 * Rollout is controlled by POST_QUOTA_MODE / POST_QUOTA_ENFORCE_FROM (see
 * getPostQuotaMode). A database failure is a 500, never a silent allow.
 */
export const requirePostQuota = (countFn = () => 1) => asyncHandler(async (req, res, next) => {
    const mode = getPostQuotaMode();
    if (mode === 'off') return next();

    const quota = await getPostQuota(req.user._id);
    if (!quota.applies) return next();

    let requested = 1;
    try {
        requested = Math.max(1, Number(countFn(req)) || 1);
    } catch {
        requested = 1;
    }

    if (quota.used + requested <= quota.limit) return next();

    if (mode === 'warn') {
        console.warn(`[post-quota] would block user=${req.user._id} used=${quota.used} requested=${requested} limit=${quota.limit}`);
        return next();
    }

    throw buildPostLimitError(quota, requested);
});

/**
 * How many posts a /create/batch request would create. The batch endpoint itself
 * rejects more than 6, so the count is clamped to 1..6; malformed JSON falls back
 * to 1 so the controller can still produce its own 400.
 */
export const batchPostCount = (req) => {
    let posts = req.body?.posts;
    if (typeof posts === 'string') {
        try {
            posts = JSON.parse(posts);
        } catch {
            return 1;
        }
    }
    return Array.isArray(posts) ? Math.min(Math.max(posts.length, 1), 6) : 1;
};

/**
 * Middleware to verify user has calling features access
 * Free users are blocked from audio and video calls
 * Paid users (small_business, corporate) and business profiles have access
 */
export const verifyCallingAccess = asyncHandler(async (req, res, next) => {
    try {
        const userId = req.user._id;

        // Get the full user object to check business profile status
        const user = await User.findById(userId);
        const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

        // Check user subscription
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        const subscriptionTier = subscription ? subscription.plan : 'free';
        req.user.subscriptionTier = subscriptionTier;
        req.user.isBusinessProfile = isBusinessProfile;

        // Only paid plans (small_business or corporate) have calling access
        if (!subscription || !['small_business', 'corporate'].includes(subscription.plan)) {
            throw new ApiError(403, "Calling features are not available for free users. Please upgrade your subscription to access audio and video calls.", {
                errorCode: 'CALLING_FEATURE_RESTRICTED',
                subscriptionTier: subscriptionTier,
                requiresUpgrade: true,
                availablePlans: ['small_business', 'corporate']
            });
        }

        // All paid plans have calling access
        next();
    } catch (error) {
        // If error is already an ApiError, throw it
        if (error instanceof ApiError) {
            throw error;
        }
        // Otherwise, throw a generic error
        throw new ApiError(500, "Error verifying calling access");
    }
});

/**
 * Middleware to check subscription tier and attach to request
 * This doesn't block the request, just adds subscription info
 */
export const attachSubscriptionInfo = asyncHandler(async (req, res, next) => {
    try {
        const userId = req.user._id;

        // Get the full user object
        const user = await User.findById(userId);
        const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

        // Check user subscription
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        const subscriptionTier = subscription ? subscription.plan : 'free';
        req.user.subscriptionTier = subscriptionTier;
        req.user.isBusinessProfile = isBusinessProfile;
        req.user.hasCallingAccess = subscription && ['small_business', 'corporate'].includes(subscription.plan);

        next();
    } catch (error) {
        console.error('Error attaching subscription info:', error);
        // Continue even if there's an error - just set defaults
        req.user.subscriptionTier = 'free';
        req.user.isBusinessProfile = false;
        req.user.hasCallingAccess = false;
        next();
    }
});

/**
 * Helper function to get user subscription details
 */
export const getUserSubscription = async (userId) => {
    try {
        const subscription = await Subscription.findOne({
            userId: userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        return {
            tier: subscription ? subscription.plan : 'free',
            hasActiveSubscription: !!subscription,
            subscription: subscription,
            hasCallingAccess: subscription && ['small_business', 'corporate'].includes(subscription.plan)
        };
    } catch (error) {
        console.error('Error getting user subscription:', error);
        return {
            tier: 'free',
            hasActiveSubscription: false,
            subscription: null,
            hasCallingAccess: false
        };
    }
};
