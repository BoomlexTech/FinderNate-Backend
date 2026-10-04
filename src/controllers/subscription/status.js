import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import Business from '../../models/business.models.js';
import { User } from '../../models/user.models.js';
import {
    PAID_TIERS,
    PLAN_LIMITS,
    getPostQuota,
    getProductCatalogUsage
} from '../../utils/planLimits.js';

const toIso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * The Corporate account-manager contact card, for the business to see.
 * Returns nothing for any other tier. An unassigned Corporate account gets
 * `pending: true` so clients can say "being assigned" rather than show a blank.
 */
const loadAccountManager = async (tier, businessProfileId) => {
    if (tier !== 'corporate' || !businessProfileId) return null;

    const business = await Business.findById(businessProfileId).select('accountManager').lean();
    const manager = business?.accountManager;

    if (manager?.name || manager?.email) {
        return {
            pending: false,
            name: manager.name || null,
            email: manager.email || null,
            phone: manager.phone || null,
            hours: manager.hours || null
        };
    }
    return { pending: true, name: null, email: null, phone: null, hours: null };
};

export const getSubscriptionStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';
    const hasCallingAccess = !!subscription && PAID_TIERS.includes(subscription.plan);

    const [postQuota, productCatalog, accountManager] = await Promise.all([
        getPostQuota(userId),
        isBusinessProfile ? getProductCatalogUsage(userId) : Promise.resolve(null),
        loadAccountManager(subscriptionTier, user.businessProfileId)
    ]);

    const boostLimits = PLAN_LIMITS[subscriptionTier].boost;

    res.status(200).json(
        new ApiResponse(200, {
            subscription,
            tier: subscriptionTier,
            isBusinessProfile,
            features: {
                calling: {
                    hasAccess: hasCallingAccess,
                    audioCall: hasCallingAccess,
                    videoCall: hasCallingAccess,
                    unlimited: hasCallingAccess
                },
                posts: {
                    applies: postQuota.applies,
                    unlimited: postQuota.unlimited,
                    limit: postQuota.limit,
                    used: postQuota.used,
                    remaining: postQuota.remaining,
                    resetsAt: toIso(postQuota.resetsAt)
                },
                productCatalog: productCatalog
                    ? {
                        unlimited: productCatalog.unlimited,
                        limit: productCatalog.limit,
                        used: productCatalog.used,
                        remaining: productCatalog.remaining
                    }
                    : null,
                insights: {
                    maxDays: PLAN_LIMITS[subscriptionTier].insightsMaxDays,
                    advanced: subscriptionTier !== 'free',
                    comparisons: subscriptionTier === 'corporate',
                    export: subscriptionTier === 'corporate'
                },
                boost: {
                    hasAccess: !!boostLimits,
                    ...(boostLimits || {})
                },
                support: {
                    priority: subscriptionTier === 'free' ? 'standard' : subscriptionTier === 'corporate' ? 'dedicated' : 'priority'
                },
                accountManager
            }
        }, 'Subscription status fetched successfully')
    );
});

export const checkFeatureAccess = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { feature } = req.params;

    const user = await User.findById(userId);
    const isBusinessProfile = user.isBusinessProfile && user.businessProfileId ? true : false;

    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    const subscriptionTier = subscription ? subscription.plan : 'free';
    const isPaid = !!subscription && PAID_TIERS.includes(subscription.plan);

    let hasAccess = false;
    let requiredTier = null;
    let extra = {};

    switch (feature) {
        case 'calling':
        case 'audio_call':
        case 'video_call':
        case 'unlimited_posts':
        case 'advanced_analytics':
        case 'boost':
        case 'priority_support':
            hasAccess = isPaid;
            requiredTier = hasAccess ? null : 'small_business';
            break;

        // "May I post right now?" — true while the Free monthly allowance lasts.
        case 'post_quota': {
            const quota = await getPostQuota(userId);
            hasAccess = !quota.applies || quota.remaining > 0;
            requiredTier = hasAccess ? null : 'small_business';
            extra = {
                limit: quota.limit,
                used: quota.used,
                remaining: quota.remaining,
                resetsAt: toIso(quota.resetsAt)
            };
            break;
        }

        // "May I add another product?" — true while the plan's catalogue has room.
        case 'product_catalog': {
            const usage = await getProductCatalogUsage(userId);
            hasAccess = usage.unlimited || usage.remaining > 0;
            requiredTier = hasAccess ? null : (usage.tier === 'free' ? 'small_business' : 'corporate');
            extra = { limit: usage.limit, used: usage.used, remaining: usage.remaining };
            break;
        }

        case 'dedicated_manager':
            hasAccess = !!subscription && subscription.plan === 'corporate';
            requiredTier = hasAccess ? null : 'corporate';
            break;

        default:
            throw new ApiError(400, 'Invalid feature specified');
    }

    res.status(200).json(
        new ApiResponse(200, {
            feature,
            hasAccess,
            currentTier: subscriptionTier,
            requiredTier,
            isBusinessProfile,
            requiresUpgrade: !hasAccess,
            ...extra
        }, 'Feature access checked successfully')
    );
});
