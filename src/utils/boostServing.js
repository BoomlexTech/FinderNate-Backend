import PostBoost from '../models/postBoost.models.js';
import { PLAN_LIMITS } from './planLimits.js';
import { istDayKey } from './boostEntitlement.js';

/**
 * Serve-time side of boosts: which posts are boosted right now, how they rank,
 * and how an impression is counted.
 *
 * A boost only counts while its author is in the active-paid set the feed,
 * Explore and search already compute (Business.subscriptionStatus 'active' and
 * plan not 'plan1'). Callers pass that set in as `paidPlanByUserId`
 * (author id string -> Business.plan). A lapsed subscriber's boost therefore
 * stops serving as soon as that flag flips, with no separate job needed.
 *
 * The weight is taken from the author's CURRENT plan, not the plan the boost
 * was bought on.
 */

// Business.plan values (see controllers/subscription/activation.js):
// plan2 = Small Business, plan3 = Corporate, plan4 = the unsold top tier, ranked with Corporate.
const CORPORATE_BUSINESS_PLANS = new Set(['plan3', 'plan4']);

export const isCorporateBusinessPlan = (businessPlan) => CORPORATE_BUSINESS_PLANS.has(businessPlan);

export const boostWeightForBusinessPlan = (businessPlan) => {
    const tier = isCorporateBusinessPlan(businessPlan) ? 'corporate' : 'small_business';
    return PLAN_LIMITS[tier].boost.weight;
};

/**
 * Search is scored, not sorted, so tier ordering is a score bonus. Small
 * Business paid posts already get +2.0 there; Corporate gets this on top.
 */
export const CORPORATE_SEARCH_BONUS = 1.0;
export const BOOST_SEARCH_BONUS_PER_WEIGHT = 2.0;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Boosts that are live now AND whose author is currently paid, as
 * [{ boostId, postId, userId, weight }] (ids as strings).
 */
export const weighLiveBoosts = (boosts, paidPlanByUserId) => {
    const weighed = [];
    for (const boost of boosts) {
        const userId = String(boost.userId);
        if (!paidPlanByUserId.has(userId)) continue;
        weighed.push({
            boostId: String(boost._id),
            postId: String(boost.postId),
            userId,
            weight: boostWeightForBusinessPlan(paidPlanByUserId.get(userId))
        });
    }
    return weighed;
};

// FNV-1a followed by murmur3's finalizer, scaled to [0, 1). Stable for one input.
// FNV-1a alone barely moves its output when only the last characters differ, and
// ids that differ only at the end are exactly what this is fed, so the
// finalizer is what makes the spread even.
const unitHash = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 0x100000000;
};

/** How many boosted posts one feed page may carry: 2 per 20, never fewer than 1. */
export const feedBoostSlotCount = (pageSize) => Math.max(1, Math.floor(pageSize / 10));

/**
 * Chooses which boosts fill the page's boosted slots. Higher weight (Corporate)
 * always comes first; within a weight the order is a hash of the seed, so it
 * rotates as the seed changes (callers seed with viewer + 5 minute bucket) and
 * no boost is starved by another at the same tier.
 */
export const selectBoostSlots = (candidates, slots, seed) => {
    // One entry per post, keeping its highest weight: a post with two ledger rows
    // (a race, or an older duplicate) must not fill two slots and push another
    // business out.
    const seen = new Set();
    const unique = [...candidates]
        .sort((a, b) => b.weight - a.weight)
        .filter((candidate) => {
            const key = String(candidate.postId);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

    return unique
        .sort((a, b) => (b.weight - a.weight) || (unitHash(`${seed}:${a.postId}`) - unitHash(`${seed}:${b.postId}`)))
        .slice(0, slots);
};

/** Rotation seed for the home feed: one value per viewer per 5 minutes (the page cache TTL). */
export const feedRotationSeed = (viewerId, now = new Date()) =>
    `${viewerId || 'guest'}:${Math.floor(now.getTime() / (5 * 60 * 1000))}`;

/**
 * Explore's order for paid-author posts, before they are interleaved among
 * ordinary ones: boosted posts first (higher weight first), then Corporate
 * posts, then Small Business posts. Each group is shuffled by `shuffle`.
 */
export const orderPaidForExplore = (posts, { boostWeightOf, isCorporateOf }, shuffle) => {
    const groups = new Map();
    for (const post of posts) {
        const weight = boostWeightOf(post);
        const corporate = isCorporateOf(post) ? 1 : 0;
        const key = `${weight}:${corporate}`;
        if (!groups.has(key)) groups.set(key, { weight, corporate, posts: [] });
        groups.get(key).posts.push(post);
    }
    return [...groups.values()]
        .sort((a, b) => (b.weight - a.weight) || (b.corporate - a.corporate))
        .flatMap((group) => shuffle(group.posts));
};

/**
 * The impressions to record for a served page: distinct boosted posts, minus
 * any the viewer authored. `served` is [{ postId, authorId }].
 */
export const impressionTargets = (served, viewerId) => {
    const viewer = viewerId ? String(viewerId) : null;
    const ids = new Set();
    for (const { postId, authorId } of served) {
        if (viewer && String(authorId) === viewer) continue;
        ids.add(String(postId));
    }
    return [...ids];
};

// ---------------------------------------------------------------------------
// Ledger access
// ---------------------------------------------------------------------------

export const liveBoostFilter = (now) => ({
    cancelledAt: null,
    startsAt: { $lte: now },
    endsAt: { $gt: now }
});

/** Live boosts whose author is currently paid. */
export const getLiveBoosts = async (paidPlanByUserId, now = new Date()) => {
    const rows = await PostBoost.find(liveBoostFilter(now)).select('postId userId').lean();
    return weighLiveBoosts(rows, paidPlanByUserId);
};

/**
 * Counts one impression for each boosted post served to the viewer. Called on
 * both the live path and the cache-hit path of the feed, since a cached page is
 * still a page somebody looked at. Fire-and-forget: a failed count must never
 * fail or slow the page. This is "times served", not unique viewers.
 */
export const recordBoostImpressions = (served, viewerId, now = new Date()) => {
    const postIds = impressionTargets(served, viewerId);
    if (postIds.length === 0) return null;

    return PostBoost.updateMany(
        { postId: { $in: postIds }, ...liveBoostFilter(now) },
        { $inc: { impressions: 1, [`daily.${istDayKey(now)}`]: 1 } }
    ).catch((error) => {
        console.error('[boost] impression count failed:', error.message);
    });
};

/**
 * Ends every boost on a post that no longer exists. Takes one post id or an array
 * of them. Cancelled rows still count towards the monthly cap.
 */
export const cancelBoostsForPost = (postId, now = new Date()) =>
    PostBoost.updateMany(
        { postId: Array.isArray(postId) ? { $in: postId } : postId, cancelledAt: null, endsAt: { $gt: now } },
        { $set: { cancelledAt: now, cancelReason: 'post_deleted' } }
    );
