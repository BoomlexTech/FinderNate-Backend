import PostBoost from '../models/postBoost.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from './ApiError.js';
import { PLAN_LIMITS, PAID_TIERS, TIER_NAMES, resolvePlanTier, istMonthWindow } from './planLimits.js';

/**
 * Who may boost what, and for how long.
 *
 * Every number comes from PLAN_LIMITS[tier].boost (utils/planLimits.js), the same
 * place the plan cards read from, so the advertised and enforced limits cannot
 * drift. The decisions are pure functions (no database, no clock of their own)
 * so they can be tested without a connection; the few functions that read the
 * ledger are at the bottom.
 *
 * Every refusal is an ApiError whose `errors` is an OBJECT, never a list: the
 * app's HTTP client treats a 403 with a LIST `errors` as the legal
 * re-acceptance gate.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
// A start time this close to "now" is a client clock being a little behind.
const START_GRACE_MS = 60 * 1000;

export const BOOSTABLE_CONTENT_TYPES = ['product', 'service', 'business'];

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD of the IST calendar day containing `date`. */
export const istDayKey = (date) =>
    new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Every IST day key from `from` to `to`, inclusive. Empty when `to` is before `from`. */
export const istDayKeysBetween = (from, to) => {
    const keys = [];
    if (to < from) return keys;
    const last = istDayKey(to);
    let cursor = new Date(from.getTime());
    for (let key = istDayKey(cursor); ; key = istDayKey(cursor)) {
        keys.push(key);
        if (key >= last) break;
        cursor = new Date(cursor.getTime() + MS_PER_DAY);
    }
    return keys;
};

/** scheduled | active | ended | cancelled, derived from the row and the clock. */
export const boostStateOf = (boost, now = new Date()) => {
    if (boost.cancelledAt) return 'cancelled';
    if (now < boost.startsAt) return 'scheduled';
    if (now >= boost.endsAt) return 'ended';
    return 'active';
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const upgradeTargetsFor = (tier) => (tier === 'free' ? PAID_TIERS : tier === 'small_business' ? ['corporate'] : []);

const formatDayMonthIST = (date) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(date);

const entitlementError = (statusCode, message, tier, extra) => {
    const availablePlans = upgradeTargetsFor(tier);
    return new ApiError(statusCode, message, {
        feature: 'boost',
        subscriptionTier: tier,
        requiresUpgrade: availablePlans.length > 0,
        availablePlans,
        ...extra
    });
};

export const boostRequiresPlanError = (tier, message) =>
    entitlementError(
        403,
        message || 'Boosts are included with the Small Business and Corporate plans. Upgrade to boost this post.',
        tier,
        { errorCode: 'BOOST_REQUIRES_PLAN' }
    );

const boostLimitError = (tier, message, extra) =>
    entitlementError(403, message, tier, { errorCode: 'BOOST_LIMIT_REACHED', ...extra });

const plainError = (statusCode, errorCode, message, extra = {}) =>
    new ApiError(statusCode, message, { errorCode, ...extra });

// ---------------------------------------------------------------------------
// Post eligibility (pure)
// ---------------------------------------------------------------------------

/**
 * The reason a post cannot be boosted, as { statusCode, errorCode, message },
 * or null when it can. A boost promotes a listing, so it has to be the owner's
 * own, public, published, not reported, and a product / service / business post.
 */
export const getBoostIneligibility = (post, userId) => {
    if (String(post.userId) !== String(userId)) {
        return { statusCode: 403, errorCode: 'BOOST_NOT_OWNER', message: 'You can only boost your own posts.' };
    }
    if (post.postType === 'story' || !BOOSTABLE_CONTENT_TYPES.includes(post.contentType)) {
        return {
            statusCode: 400,
            errorCode: 'BOOST_POST_NOT_ELIGIBLE',
            message: 'Only product, service and business posts can be boosted.'
        };
    }
    if ((post.settings?.privacy ?? 'public') !== 'public') {
        return {
            statusCode: 400,
            errorCode: 'BOOST_POST_NOT_ELIGIBLE',
            message: 'Only public posts can be boosted. Make this post public first.'
        };
    }
    if ((post.status ?? 'published') !== 'published') {
        return {
            statusCode: 400,
            errorCode: 'BOOST_POST_NOT_ELIGIBLE',
            message: 'Only published posts can be boosted.'
        };
    }
    if (post.isReported === true) {
        return {
            statusCode: 400,
            errorCode: 'BOOST_POST_NOT_ELIGIBLE',
            message: 'A post that has been reported cannot be boosted.'
        };
    }
    return null;
};

// ---------------------------------------------------------------------------
// Limits (pure)
// ---------------------------------------------------------------------------

/**
 * Highest number of `existing` boosts that are live at the same moment anywhere
 * inside [start, end). Intervals are half-open, so one that ends exactly as
 * another starts does not overlap it.
 */
export const peakOverlap = (existing, start, end) => {
    const events = [];
    for (const boost of existing) {
        const from = Math.max(boost.startsAt.getTime(), start.getTime());
        const to = Math.min(boost.endsAt.getTime(), end.getTime());
        if (from >= to) continue;
        events.push([from, 1], [to, -1]);
    }
    // At the same instant, ends sort before starts.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let live = 0;
    let peak = 0;
    for (const [, delta] of events) {
        live += delta;
        if (live > peak) peak = live;
    }
    return peak;
};

const parseDays = (days, maxDays) => {
    const parsed = typeof days === 'string' && days.trim() !== '' ? Number(days) : days;
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw plainError(400, 'BOOST_DURATION_INVALID', 'Choose how many days to boost for.', { maxDays });
    }
    if (parsed > maxDays) {
        throw plainError(400, 'BOOST_DURATION_INVALID', `A boost can run for up to ${maxDays} days on your plan.`, { maxDays });
    }
    return parsed;
};

const parseStart = (startsAt, limits, now, tier) => {
    if (startsAt === undefined || startsAt === null || startsAt === '') return new Date(now.getTime());

    const requested = new Date(startsAt);
    if (Number.isNaN(requested.getTime())) {
        throw plainError(400, 'BOOST_START_INVALID', 'That start date is not valid.');
    }
    if (requested.getTime() <= now.getTime() + START_GRACE_MS) return new Date(now.getTime());

    if (!limits.canSchedule) {
        throw boostRequiresPlanError(
            tier,
            'Scheduling a boost for a later date is available on the Corporate plan. Start this boost now, or upgrade to Corporate.'
        );
    }
    const latest = now.getTime() + limits.maxScheduleAheadDays * MS_PER_DAY;
    if (requested.getTime() > latest) {
        throw plainError(
            400,
            'BOOST_START_INVALID',
            `A boost can be scheduled up to ${limits.maxScheduleAheadDays} days ahead.`,
            { maxScheduleAheadDays: limits.maxScheduleAheadDays }
        );
    }
    return requested;
};

/**
 * Decides whether a new boost may be created and when it runs. Throws the
 * ApiError to send when not.
 *
 * @param {object} input
 * @param {string} input.tier            free | small_business | corporate
 * @param {*}      input.days            requested duration in days
 * @param {*}      input.startsAt        optional requested start (Corporate only)
 * @param {Date}   input.now
 * @param {Function} input.loadLedger    async ({ startsAt, endsAt }) =>
 *     { overlapping: [{postId, startsAt, endsAt}] (this user's non-cancelled
 *       boosts overlapping the window), monthStarts: number (this user's
 *       boosts, cancelled or not, starting in the IST month of startsAt) }
 * @param {string} input.postId
 * @returns {Promise<{ startsAt: Date, endsAt: Date }>}
 */
export const evaluateBoostRequest = async ({ tier, days, startsAt, now = new Date(), loadLedger, postId }) => {
    const limits = PLAN_LIMITS[tier]?.boost;
    if (!limits) throw boostRequiresPlanError(tier);

    const runDays = parseDays(days, limits.maxDays);
    const start = parseStart(startsAt, limits, now, tier);
    const end = new Date(start.getTime() + runDays * MS_PER_DAY);

    const { overlapping, monthStarts } = await loadLedger({ startsAt: start, endsAt: end });
    const tierName = TIER_NAMES[tier];

    if (overlapping.some((boost) => String(boost.postId) === String(postId))) {
        throw plainError(409, 'BOOST_ALREADY_EXISTS', 'This post already has a boost running or scheduled for those dates.');
    }

    // + 1 for the boost being created, which is live for the whole window.
    if (peakOverlap(overlapping, start, end) + 1 > limits.maxConcurrent) {
        const upgrade = tier === 'small_business'
            ? ` Upgrade to Corporate to boost up to ${PLAN_LIMITS.corporate.boost.maxConcurrent} posts at once.`
            : '';
        const noun = limits.maxConcurrent === 1 ? 'boost' : 'boosts';
        throw boostLimitError(
            tier,
            `The ${tierName} plan allows ${limits.maxConcurrent} ${noun} at a time, and that many are already running or scheduled for those dates. Wait for one to end or cancel it.${upgrade}`,
            { limit: 'concurrent', max: limits.maxConcurrent }
        );
    }

    if (limits.maxPerMonth != null && monthStarts >= limits.maxPerMonth) {
        const { resetsAt } = istMonthWindow(start);
        throw boostLimitError(
            tier,
            `You've started all ${limits.maxPerMonth} boosts for this month on the ${tierName} plan. Upgrade to Corporate for unlimited boosts, or start another from ${formatDayMonthIST(resetsAt)}.`,
            { limit: 'monthly', max: limits.maxPerMonth, used: monthStarts, resetsAt: resetsAt.toISOString() }
        );
    }

    return { startsAt: start, endsAt: end };
};

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------

/** The caller's plan and boost limits. Throws when they cannot boost at all. */
export const resolveBoostAccess = async (userId) => {
    const [user, tier] = await Promise.all([
        User.findById(userId).select('isBusinessProfile').lean(),
        resolvePlanTier(userId)
    ]);

    // A personal account cannot subscribe, so it is told what it needs rather than offered plans.
    if (!user?.isBusinessProfile) {
        throw plainError(403, 'BOOST_REQUIRES_BUSINESS_ACCOUNT', 'Boosts are available to business accounts.', {
            feature: 'boost',
            requiresUpgrade: false
        });
    }
    const limits = PLAN_LIMITS[tier].boost;
    if (!limits) throw boostRequiresPlanError(tier);
    return { tier, limits };
};

/**
 * Drops boosts whose post no longer exists. Deleting a post through the app
 * cancels its boosts, but admin removals and business-profile deletion do not,
 * and a boost on a vanished post must not keep holding one of the owner's
 * concurrent slots until it runs out.
 */
const withoutDeletedPosts = async (boosts) => {
    if (boosts.length === 0) return boosts;
    const existing = await Post.find({ _id: { $in: boosts.map((boost) => boost.postId) } }).select('_id').lean();
    const alive = new Set(existing.map((post) => String(post._id)));
    return boosts.filter((boost) => alive.has(String(boost.postId)));
};

/** Ledger lookups evaluateBoostRequest needs, for one user. */
export const makeLedgerLoader = (userId) => async ({ startsAt, endsAt }) => {
    const { start, resetsAt } = istMonthWindow(startsAt);
    const [overlapping, monthStarts] = await Promise.all([
        PostBoost.find({
            userId,
            cancelledAt: null,
            startsAt: { $lt: endsAt },
            endsAt: { $gt: startsAt }
        }).select('postId startsAt endsAt').lean().then(withoutDeletedPosts),
        PostBoost.countDocuments({ userId, startsAt: { $gte: start, $lt: resetsAt } })
    ]);
    return { overlapping, monthStarts };
};

/**
 * What the caller has used against their limits right now. Safe for a Free
 * account: limits come back null and the counts reflect any history.
 */
export const getBoostUsage = async (userId, { now = new Date() } = {}) => {
    const tier = await resolvePlanTier(userId);
    const limits = PLAN_LIMITS[tier].boost;
    const { start, resetsAt } = istMonthWindow(now);

    const [live, monthStarts] = await Promise.all([
        PostBoost.find({ userId, cancelledAt: null, endsAt: { $gt: now } }).select('postId startsAt endsAt').lean().then(withoutDeletedPosts),
        PostBoost.countDocuments({ userId, startsAt: { $gte: start, $lt: resetsAt } })
    ]);
    const activeNow = live.filter((boost) => boost.startsAt <= now).length;

    return {
        tier,
        planName: TIER_NAMES[tier],
        limits: limits ? { ...limits } : null,
        activeNow,
        scheduled: live.length - activeNow,
        monthStarts,
        monthResetsAt: resetsAt.toISOString()
    };
};
