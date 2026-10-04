import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { PLAN_LIMITS } from '../../utils/planLimits.js';

export const SUBSCRIPTION_PLANS = {
    free: {
        id: 'free',
        name: 'Free',
        price: 0,
        duration: 'lifetime'
    },
    small_business: {
        id: 'small_business',
        name: 'Small Business',
        price: 19,
        duration: 'monthly'
    },
    corporate: {
        id: 'corporate',
        name: 'Corporate',
        price: 999,
        duration: 'monthly'
    }
};

/**
 * Google Play product id → our plan tier.
 *
 * The ids are identical to the tier names on purpose, so there is one less
 * thing to keep in step, but the map is written out rather than assumed: Play
 * product ids are permanent once a product is created, so if a tier is ever
 * renamed the old id has to keep working and this is where that would live.
 *
 * Each product carries a single `monthly` base plan in Play; the billing period
 * lives on the base plan, not on the product, so it is not part of the id.
 */
export const PLAY_PRODUCT_TO_PLAN = {
    small_business: 'small_business',
    corporate: 'corporate'
};

/** The inverse, for telling the app which products to fetch from Play. */
export const PLAN_TO_PLAY_PRODUCT = Object.fromEntries(
    Object.entries(PLAY_PRODUCT_TO_PLAN).map(([productId, plan]) => [plan, productId])
);

/**
 * Plans the owner has chosen to hold back without an app release.
 *
 * PLANS_COMING_SOON is a comma separated list of plan ids (e.g. "corporate").
 * A plan listed there is sent to clients with `comingSoon: true`, so the app and
 * website show "Coming soon" instead of a Subscribe button, and the purchase
 * endpoints refuse it (see assertPlanPurchasable) so a stale client cannot buy it.
 */
export const getComingSoonPlans = () =>
    String(process.env.PLANS_COMING_SOON || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

export const isPlanComingSoon = (planId) => getComingSoonPlans().includes(planId);

/**
 * The one list of what each plan includes. Every bullet here is either enforced
 * by code or delivered by a feature that ships with it; the numbers are read
 * from PLAN_LIMITS so the copy and the enforcement cannot disagree. The app
 * renders this list as-is; the website renders it too (GET /subscription/plans).
 */
const buildPlanCatalog = () => {
    const free = PLAN_LIMITS.free;
    const small = PLAN_LIMITS.small_business;
    const corp = PLAN_LIMITS.corporate;

    return [
        {
            id: 'free',
            name: 'Free',
            price: '₹0',
            period: 'Forever',
            features: [
                'Basic business profile',
                `Up to ${free.postsPerMonth} posts per month`,
                `Product catalog (up to ${free.productCatalog} items)`,
                `Basic insights: followers, likes and comments for the last ${free.insightsMaxDays} days`,
                'Help Center and email support'
            ],
            limitations: [
                'No audio or video calling',
                'Product, service and business posts are not shown in Explore or Search',
                'Standard support queue'
            ],
            isCurrentPlan: true
        },
        {
            id: 'small_business',
            name: 'Small Business',
            price: `₹${SUBSCRIPTION_PLANS.small_business.price}`,
            period: 'per month',
            features: [
                'Verified business badge',
                'Audio and video calling',
                'Product, service and business posts promoted in Explore, Search and the home feed',
                'Unlimited posts',
                `Product catalog (up to ${small.productCatalog} items)`,
                `Advanced analytics: ${small.insightsMaxDays}-day trends, per-post performance and enquiries`,
                'Priority support: answered ahead of standard requests',
                `Boost ${small.boost.maxConcurrent} post at a time (${small.boost.maxDays} days)`
            ],
            recommended: true
        },
        {
            id: 'corporate',
            name: 'Corporate',
            price: `₹${SUBSCRIPTION_PLANS.corporate.price}`,
            period: 'per month',
            features: [
                'Everything in Small Business',
                'Corporate badge and placement above Small Business accounts',
                'Unlimited product catalog',
                `Advanced analytics & insights: ${corp.insightsMaxDays}-day history, period comparisons, best time to post and CSV export`,
                `Boost up to ${corp.boost.maxConcurrent} posts at once, schedule campaigns and get performance reports`,
                'Dedicated account manager'
            ],
            recommended: false
        }
    ];
};

export const getAvailablePlans = asyncHandler(async (req, res) => {
    const holdBack = new Set(getComingSoonPlans());

    const plans = buildPlanCatalog().map((plan) => ({
        ...plan,
        currency: 'INR',
        comingSoon: plan.id !== 'free' && holdBack.has(plan.id)
    }));

    res.status(200).json(
        new ApiResponse(200, { plans }, 'Available plans fetched successfully')
    );
});
