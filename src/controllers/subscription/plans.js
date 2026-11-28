import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { PLAN_LIMITS, TIER_NAMES } from '../../utils/planLimits.js';
import { badgeForPlan } from '../../constants/subscriptionBadges.js';

/**
 * The business plans: Basic ₹9, Pro ₹19, Premium ₹29 a month (and Free).
 *
 * `small_business` and `corporate` are the ids Pro and Premium were first sold
 * under ("Small Business" and "Corporate"). The ids stay, because every
 * subscription row and both Google Play products carry them; the names come
 * from TIER_NAMES so the whole server calls each plan the same thing.
 */
export const SUBSCRIPTION_PLANS = {
    free: {
        id: 'free',
        name: TIER_NAMES.free,
        price: 0,
        duration: 'lifetime'
    },
    basic: {
        id: 'basic',
        name: TIER_NAMES.basic,
        price: 9,
        duration: 'monthly'
    },
    small_business: {
        id: 'small_business',
        name: TIER_NAMES.small_business,
        price: 19,
        duration: 'monthly'
    },
    corporate: {
        id: 'corporate',
        name: TIER_NAMES.corporate,
        price: 29,
        duration: 'monthly'
    }
};

/**
 * What Pro and Premium were called before the rename. A Cashfree order keeps
 * the plan's name in its note, so an order created just before the rename is
 * still recognised when its payment is confirmed afterwards.
 */
export const LEGACY_PLAN_NAMES = {
    'Small Business': 'small_business',
    'Corporate': 'corporate'
};

/**
 * Which paid plan a Cashfree order bought, from the note written on the order
 * when it was created ("FinderNate Pro Subscription") and, failing that, from
 * the amount. Null when it cannot be told.
 *
 * The plan names never contain one another (Basic, Pro, Premium), so a plain
 * "includes" cannot pick the wrong one.
 */
export const planFromOrderNote = (orderNote, orderAmount) => {
    const note = String(orderNote || '');
    const paidPlans = Object.entries(SUBSCRIPTION_PLANS).filter(([, plan]) => plan.price > 0);

    const byName = paidPlans.find(([, plan]) => note.includes(plan.name));
    if (byName) return byName[0];

    // An order created before Pro and Premium got those names still says
    // "Small Business" or "Corporate", and Premium's old price (₹999) matches
    // no plan today, so the amount below could not place it.
    const byOldName = Object.entries(LEGACY_PLAN_NAMES).find(([oldName]) => note.includes(oldName));
    if (byOldName) return byOldName[1];

    const paidAmount = Number(orderAmount);
    const byPrice = paidPlans.filter(([, plan]) => plan.price === paidAmount);
    return byPrice.length === 1 ? byPrice[0][0] : null;
};

/**
 * Google Play product id → our plan tier.
 *
 * The ids are identical to the tier names on purpose, so there is one less
 * thing to keep in step, but the map is written out rather than assumed: Play
 * product ids are permanent once a product is created, so if a tier is ever
 * renamed the old id has to keep working and this is where that would live.
 * (Pro and Premium are exactly that case: the products are still
 * `small_business` and `corporate`.)
 *
 * Each product carries a single `monthly` base plan in Play; the billing period
 * lives on the base plan, not on the product, so it is not part of the id.
 */
export const PLAY_PRODUCT_TO_PLAN = {
    basic: 'basic',
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
 *
 * Each paid plan also carries its own `badge` (label and colour), the same one
 * shown next to the business's name, so the plan card can show which badge the
 * plan gives.
 */
export const buildPlanCatalog = () => {
    const free = PLAN_LIMITS.free;
    const basic = PLAN_LIMITS.basic;
    const pro = PLAN_LIMITS.small_business;
    const premium = PLAN_LIMITS.corporate;

    return [
        {
            id: 'free',
            name: TIER_NAMES.free,
            price: '₹0',
            period: 'Forever',
            tagline: 'Set up your business profile',
            features: [
                'Basic business profile',
                `Up to ${free.postsPerMonth} posts per month`,
                `Product catalog (up to ${free.productCatalog} items)`,
                `Basic insights: followers, likes and comments for the last ${free.insightsMaxDays} days`,
                'Help Center and email support'
            ],
            limitations: [
                'No plan badge',
                'No audio or video calling',
                'Product, service and business posts are not shown in Explore or Search',
                'Standard support queue'
            ],
            badge: null,
            isCurrentPlan: true
        },
        {
            id: 'basic',
            name: TIER_NAMES.basic,
            price: `₹${SUBSCRIPTION_PLANS.basic.price}`,
            period: 'per month',
            tagline: 'Get found by customers',
            features: [
                'Basic badge next to your business name',
                'Product, service and business posts shown in Explore, Search and the home feed',
                `Up to ${basic.postsPerMonth} posts per month`,
                `Product catalog (up to ${basic.productCatalog} items)`,
                `Insights for the last ${basic.insightsMaxDays} days: followers, likes and comments`,
                'Help Center and email support'
            ],
            limitations: [
                'No audio or video calling',
                'No post boosts'
            ],
            badge: badgeForPlan('basic'),
            recommended: false
        },
        {
            id: 'small_business',
            name: TIER_NAMES.small_business,
            price: `₹${SUBSCRIPTION_PLANS.small_business.price}`,
            period: 'per month',
            tagline: 'Sell and talk to customers',
            features: [
                'Everything in Basic',
                'Pro badge next to your business name',
                'Audio and video calling',
                'Unlimited posts',
                `Product catalog (up to ${pro.productCatalog} items)`,
                `Advanced analytics: ${pro.insightsMaxDays}-day trends, per-post performance and enquiries`,
                'Priority support: answered ahead of standard requests',
                `Boost ${pro.boost.maxConcurrent} post at a time (${pro.boost.maxDays} days)`
            ],
            badge: badgeForPlan('small_business'),
            recommended: true
        },
        {
            id: 'corporate',
            name: TIER_NAMES.corporate,
            price: `₹${SUBSCRIPTION_PLANS.corporate.price}`,
            period: 'per month',
            tagline: 'Everything, with top placement',
            features: [
                'Everything in Pro',
                'Premium badge and placement above Basic and Pro accounts',
                'Unlimited product catalog',
                `Advanced analytics & insights: ${premium.insightsMaxDays}-day history, period comparisons, best time to post and CSV export`,
                `Boost up to ${premium.boost.maxConcurrent} posts at once, schedule campaigns and get performance reports`,
                'Dedicated account manager'
            ],
            badge: badgeForPlan('corporate'),
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
