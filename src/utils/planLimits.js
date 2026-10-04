import Post from '../models/userPost.models.js';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from './ApiError.js';
import { isPlatformStoreUser } from '../constants/platformStore.js';

/**
 * Single home for every number a plan is sold on.
 *
 * Anything a plan card, a limit error or an enforcement check says about "10
 * posts" or "50 products" reads from PLAN_LIMITS, so the advertised number and
 * the enforced number cannot drift apart. `null` always means "unlimited".
 *
 * Tier is the active Subscription (status 'active' AND endDate in the future),
 * the same rule the calling gate and the badge use. It is NOT Business.plan,
 * which lags expiry by up to a day.
 */

export const PAID_TIERS = ['small_business', 'corporate'];

export const TIER_NAMES = {
    free: 'Free',
    small_business: 'Small Business',
    corporate: 'Corporate'
};

const positiveIntFromEnv = (name, fallback) => {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const PLAN_LIMITS = Object.freeze({
    free: Object.freeze({
        postsPerMonth: positiveIntFromEnv('FREE_MONTHLY_POST_LIMIT', 10),
        productCatalog: 10,
        insightsMaxDays: 7,
        boost: null
    }),
    small_business: Object.freeze({
        postsPerMonth: null,
        productCatalog: 50,
        insightsMaxDays: 30,
        boost: Object.freeze({
            maxConcurrent: 1,
            maxDays: 7,
            maxPerMonth: 4,
            canSchedule: false,
            maxScheduleAheadDays: 0,
            weight: 1
        })
    }),
    corporate: Object.freeze({
        postsPerMonth: null,
        productCatalog: null,
        insightsMaxDays: 90,
        boost: Object.freeze({
            maxConcurrent: 5,
            maxDays: 30,
            maxPerMonth: null,
            canSchedule: true,
            maxScheduleAheadDays: 30,
            weight: 2
        })
    })
});

/**
 * The plan the user is entitled to right now.
 *
 * Deliberately lets a database error propagate: a gate that quietly falls back
 * to 'free' on a transient failure would wrongly block a paying customer.
 */
export const resolvePlanTier = async (userId) => {
    const subscription = await Subscription.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    }).select('plan').lean();

    return subscription && PAID_TIERS.includes(subscription.plan) ? subscription.plan : 'free';
};

// ---------------------------------------------------------------------------
// Monthly window. Calendar month in IST, to match the cron jobs and the rupee
// pricing. Plain arithmetic: there is no date library in this project.
// ---------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * 60 * 1000;

export const istMonthWindow = (now = new Date()) => {
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    return {
        start: new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS),
        resetsAt: new Date(Date.UTC(year, month + 1, 1) - IST_OFFSET_MS)
    };
};

const formatDayMonthIST = (date) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(date);

// ---------------------------------------------------------------------------
// Posts per month (Free business accounts)
// ---------------------------------------------------------------------------

/**
 * How many posts the account may still create this month.
 *
 * Applies only to an account that is in business mode AND has no active paid
 * subscription. Personal accounts, paid accounts and the platform store account
 * are never limited. Counts every Post document the user authored this IST
 * month regardless of type or status (status is client-controlled, so filtering
 * on it would be dodgeable). Stories are a separate collection and are excluded.
 *
 * Known, accepted looseness: deleting a post frees a slot, and simultaneous
 * requests can overshoot by the number in flight.
 */
export const getPostQuota = async (userId) => {
    const [user, tier] = await Promise.all([
        User.findById(userId).select('isBusinessProfile').lean(),
        resolvePlanTier(userId)
    ]);

    const tierLimit = PLAN_LIMITS[tier].postsPerMonth;
    const applies = !!user?.isBusinessProfile && !isPlatformStoreUser(userId) && tierLimit != null;

    if (!applies) {
        return { applies: false, tier, limit: null, unlimited: true, used: null, remaining: null, resetsAt: null };
    }

    const { start, resetsAt } = istMonthWindow();
    const used = await Post.countDocuments({ userId, createdAt: { $gte: start } });

    return {
        applies: true,
        tier,
        limit: tierLimit,
        unlimited: false,
        used,
        remaining: Math.max(0, tierLimit - used),
        resetsAt
    };
};

export const buildPostLimitError = (quota, requested = 1) => {
    const resetLabel = formatDayMonthIST(quota.resetsAt);
    const message = requested > 1
        ? (quota.remaining > 0
            ? `This batch has ${requested} posts but you have ${quota.remaining} left this month on the Free plan (limit ${quota.limit}). Remove ${requested - quota.remaining} or upgrade for unlimited posts.`
            : `You've used all ${quota.limit} posts for this month on the Free plan. Upgrade to Small Business for unlimited posts, or post again from ${resetLabel}.`)
        : `You've used all ${quota.limit} posts for this month on the Free plan. Upgrade to Small Business for unlimited posts, or post again from ${resetLabel}.`;

    // `errors` is an OBJECT on purpose. The app's HTTP client treats a 403 whose
    // `errors` is a LIST as the legal re-acceptance gate; an object is ignored by
    // both clients' interceptors and mirrors CALLING_FEATURE_RESTRICTED.
    return new ApiError(403, message, {
        errorCode: 'POST_LIMIT_REACHED',
        feature: 'posts',
        subscriptionTier: quota.tier,
        requiresUpgrade: true,
        limit: quota.limit,
        used: quota.used,
        remaining: quota.remaining,
        requested,
        resetsAt: quota.resetsAt.toISOString(),
        availablePlans: PAID_TIERS
    });
};

/**
 * POST_QUOTA_MODE: 'enforce' (default) | 'warn' (log only) | 'off'.
 * POST_QUOTA_ENFORCE_FROM: ISO date; before it, 'enforce' behaves as 'warn'.
 * Lets the cap ship now and start biting on a chosen day.
 */
export const getPostQuotaMode = (now = new Date()) => {
    const mode = String(process.env.POST_QUOTA_MODE || 'enforce').toLowerCase();
    if (mode === 'off' || mode === 'warn') return mode;
    const from = process.env.POST_QUOTA_ENFORCE_FROM ? new Date(process.env.POST_QUOTA_ENFORCE_FROM) : null;
    if (from && !Number.isNaN(from.getTime()) && now < from) return 'warn';
    return 'enforce';
};

// ---------------------------------------------------------------------------
// Product catalogue size
// ---------------------------------------------------------------------------

/**
 * A "catalogue item" is a Post with contentType 'product'. Everything the seller
 * owns counts, regardless of status or privacy: a private product can still be
 * sold through a payment link, and status is client-controlled.
 */
export const getProductCatalogUsage = async (userId) => {
    const tier = await resolvePlanTier(userId);
    const limit = PLAN_LIMITS[tier].productCatalog;
    const exempt = isPlatformStoreUser(userId);

    const used = await Post.countDocuments({ userId, contentType: 'product' });
    const effectiveLimit = exempt ? null : limit;

    return {
        tier,
        limit: effectiveLimit,
        unlimited: effectiveLimit == null,
        used,
        remaining: effectiveLimit == null ? null : Math.max(0, effectiveLimit - used)
    };
};

export const buildProductLimitError = (usage, adding = 1) => {
    const planName = TIER_NAMES[usage.tier];
    const upgradeTo = usage.tier === 'free' ? 'small_business' : 'corporate';

    let message;
    if (adding > 1) {
        message = `This would add ${adding} products but you have room for ${usage.remaining} more on the ${planName} plan (limit ${usage.limit}). Remove some from the batch, delete older products, or upgrade.`;
    } else if (usage.tier === 'free') {
        message = `You've reached the Free plan limit of ${usage.limit} products. Delete a product or upgrade to Small Business to list up to ${PLAN_LIMITS.small_business.productCatalog}.`;
    } else {
        message = `You've reached the ${planName} limit of ${usage.limit} products. Delete a product or upgrade to Corporate for an unlimited catalogue.`;
    }

    return new ApiError(403, message, {
        errorCode: 'PRODUCT_LIMIT_REACHED',
        feature: 'products',
        subscriptionTier: usage.tier,
        requiresUpgrade: true,
        limit: usage.limit,
        used: usage.used,
        remaining: usage.remaining,
        requested: adding,
        upgradeTo,
        availablePlans: PAID_TIERS
    });
};

/**
 * Throws a 403 when adding `adding` products would take the seller past their
 * plan's catalogue size. Create-only: existing products are never hidden or
 * deleted, so an account already over the cap is grandfathered and simply cannot
 * add more until it drops below.
 */
export const assertProductCapacity = async (userId, adding = 1) => {
    if (isPlatformStoreUser(userId)) return null;

    const usage = await getProductCatalogUsage(userId);
    if (usage.unlimited) return usage;

    if (usage.used + adding > usage.limit) {
        throw buildProductLimitError(usage, adding);
    }
    return usage;
};
