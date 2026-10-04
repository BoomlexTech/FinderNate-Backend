// ─────────────────────────────────────────────────────────────────────────────
// Everything an activation path shares, whichever gateway paid for it.
//
// This module exists because of the Razorpay lesson recorded in payment.js: a
// second activation path once held a verbatim copy of the renewal arithmetic,
// the two copies drifted, and only one of them ever got the month-overflow fix.
// Google Play Billing is that second path arriving again, so the shared parts
// live here and both callers import them rather than copying them.
//
// What is NOT here: deciding which plan was bought, checking that the money
// actually arrived, and attributing the payment to an account. Those are
// gateway-specific — Cashfree answers them from an order we fetch, Google Play
// from a purchase we fetch — and each caller does its own before calling in.
// ─────────────────────────────────────────────────────────────────────────────

import Subscription from '../../models/subscription.models.js';
import { sendAdminAlert } from '../../utils/adminAlert.utils.js';
import { needsAccountManagerAlert } from '../../utils/accountManager.utils.js';
import { announceActivation, announcePlanEnded, reopenActivationNotice } from './notices.js';

/** Which Business.plan tier a subscription maps to. */
export const PLAN_TO_BUSINESS_PLAN = {
    small_business: 'plan2',
    corporate: 'plan3'
};

/**
 * Should a business keep its verified tick once its paid plan has ended?
 *
 * Only if an admin approved it through KYC. A tick that came from paying goes
 * with the plan; one an admin granted after reviewing the documents does not.
 */
export const isVerifiedAfterLapse = (business) => business?.verificationStatus === 'approved';

/**
 * Drops a business back to the free tier. The one place both the expiry job and
 * a store-driven deactivation do it, so the two cannot drift apart.
 */
export const downgradeBusinessToFree = async (userId) => {
    const Business = (await import('../../models/business.models.js')).default;
    const business = await Business.findOne({ userId }).select('verificationStatus').lean();
    if (!business) return;

    await Business.updateOne(
        { userId },
        { $set: { plan: 'plan1', subscriptionStatus: 'pending', isVerified: isVerifiedAfterLapse(business) } }
    );
};

// Tells the owner a Corporate subscriber is waiting for the manager the plan
// promises. Runs after the activation has been written and is never awaited.
const alertCorporateNeedsManager = async (user, business) => {
    try {
        await sendAdminAlert({
            subject: 'New Corporate subscriber needs an account manager',
            title: 'New Corporate subscriber',
            preheader: `${business.businessName || user.fullName} subscribed to Corporate.`,
            intro: 'A Corporate subscriber has no account manager yet. The plan promises a dedicated one, and their app shows "being assigned" until you set one.',
            details: [
                ['Business', business.businessName],
                ['Owner', user.fullName],
                ['Email', user.email],
                ['Phone', user.phoneNumber]
            ],
            footer: 'Assign one under Admin > All Businesses > Corporate without manager.'
        });
    } catch (error) {
        console.error('Could not send the Corporate account-manager alert:', error?.message);
    }
};

// Adds one calendar month without the Date.setMonth() overflow that turned a
// 31-January renewal into 3 March and handed out free days.
export const addOneMonth = (from) => {
    const next = new Date(from);
    const day  = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDayOfTargetMonth));
    return next;
};

export const invalidateCaches = async (userId) => {
    const { FeedCacheManager, UserCacheManager } = await import('../../utils/cache.utils.js');
    await Promise.allSettled([
        UserCacheManager.invalidateUserProfile(userId.toString()),
        FeedCacheManager.invalidateUserFeed(userId),
        FeedCacheManager.invalidateExploreFeed(),
        FeedCacheManager.invalidateTrendingFeed()
    ]);
    const { redisClient } = await import('../../config/redis.config.js');
    const feedKeys = await redisClient.keys('fn:user:*:feed:*');
    if (feedKeys.length > 0) await redisClient.del(...feedKeys);
};

/**
 * Has [paymentIds] already bought somebody a subscription?
 *
 * Looks at `redeemedPaymentIds` — the full redemption history — and not at the
 * scalar `paymentId`, which renewal overwrites. A gateway receipt stays valid
 * forever at the gateway, so a guard that can only see the most recent payment
 * lets an older one be replayed for a free month once a renewal has happened.
 *
 * Returns the Subscription that already redeemed one of these ids, or null.
 */
export const findRedemption = async (paymentIds) => {
    const keys = paymentIds.filter(Boolean).map(String);
    if (keys.length === 0) return null;
    return Subscription.findOne({
        $or: [
            { redeemedPaymentIds: { $in: keys } },
            { paymentId: { $in: keys } }
        ]
    });
};

/**
 * Is [subscription] paying out right now? The same test resolvePlanTier and
 * getSubscriptionStatus apply, so "entitled" means one thing everywhere.
 */
export const isEntitledNow = (subscription, now = new Date()) =>
    Boolean(
        subscription &&
        subscription.status === 'active' &&
        subscription.endDate &&
        new Date(subscription.endDate) > now
    );

/**
 * Is Google Play going to charge this user AGAIN for a plan they hold right now?
 *
 * The question behind both double-billing guards: a Cashfree order must not be
 * sold on top of such a plan, and a Play purchase that is not an upgrade or
 * downgrade of it must not be accepted. Either would leave two things billing
 * (or, on the web, Play billing a plan we have stopped listening to), and the
 * next Play renewal would flip the plan back. A Play plan the user has already
 * cancelled (autoRenew false) will not bill again, so it is not a conflict.
 */
export const isRenewingPlaySubscription = (subscription, now = new Date()) =>
    Boolean(
        subscription &&
        subscription.source === 'google_play' &&
        subscription.autoRenew === true &&
        isEntitledNow(subscription, now)
    );

/**
 * Could Google Play still be charging this user, whatever endDate says?
 *
 * [isRenewingPlaySubscription] is the strict form and needs the plan to be
 * entitled right now. A Play row that is past its endDate but still `active`
 * with autoRenew on is the other case worth a look: either Play has renewed and
 * we have not heard yet, or the user is in Play's grace period and Play is still
 * retrying the card. Neither is knowable from the row, so this only says "worth
 * asking Play" and playRowStillRenews (googlePlay.js) does the asking.
 */
export const isPossiblyBillingPlaySubscription = (subscription) =>
    Boolean(
        subscription &&
        subscription.source === 'google_play' &&
        subscription.status === 'active' &&
        subscription.autoRenew === true &&
        subscription.playPurchaseToken
    );

const PLAN_RANK = { free: 0, small_business: 1, corporate: 2 };

/** Corporate > Small Business > Free; an unknown plan counts as Free. */
export const planRank = (plan) => PLAN_RANK[plan] ?? 0;

/**
 * The success line for an activation. "Upgraded" is only true for an upgrade, so
 * a change to a LOWER plan is worded as a switch (it used to say "upgraded to
 * Small Business" to someone who had just moved down from Corporate).
 * [previousPlan] is the plan the user is moving away from, or null when there is
 * none (a first purchase). It is NOT limited to a plan that is still running: a
 * scheduled downgrade lands exactly when the old plan's period ends, so by then
 * the old plan no longer counts as entitled but is still what the user moved
 * down from.
 */
export const planChangeMessage = ({ planName, plan, previousPlan, alreadyApplied }) => {
    if (alreadyApplied) return `Your ${planName} plan is already active.`;
    const movedDown =
        Boolean(previousPlan) &&
        previousPlan !== plan &&
        planRank(plan) < planRank(previousPlan);
    return movedDown
        ? `Successfully switched to ${planName} plan!`
        : `Successfully upgraded to ${planName} plan!`;
};

/**
 * The most replaced Play tokens we remember per user. Each costs a user real
 * money to create (every one is a paid plan change), so the cap is only there to
 * keep the row bounded; it is far above anything a real account reaches.
 */
export const MAX_RETIRED_PLAY_TOKENS = 50;

/**
 * Adds [token] to the row's retired list, once.
 *
 * Deliberately addToSet, not "assign a new array": assigning makes Mongoose send
 * a $set of the whole array AND put `__v` in the update's filter, so two writers
 * that both loaded the row (the app's verify and Play's notification for the same
 * new token, a few seconds apart) race on the version, and the loser gets a
 * VersionError after the user has already paid. $addToSet only increments `__v`,
 * and it is idempotent, so both writers can retire the same token safely. The cap
 * is applied afterwards by trimRetiredPlayTokens, again without a version check.
 */
const retirePlayToken = (subscription, token) => {
    if (!token) return;
    if (!Array.isArray(subscription.retiredPlayTokens)) subscription.retiredPlayTokens = [];
    subscription.retiredPlayTokens.addToSet(token);
};

/** Keeps only the newest MAX_RETIRED_PLAY_TOKENS entries, in one atomic update. */
const trimRetiredPlayTokens = async (subscription) => {
    if (!(subscription.retiredPlayTokens?.length > MAX_RETIRED_PLAY_TOKENS)) return;
    await Subscription.updateOne(
        { _id: subscription._id },
        { $push: { retiredPlayTokens: { $each: [], $slice: -MAX_RETIRED_PLAY_TOKENS } } }
    );
};

/**
 * A Subscription as clients may see it.
 *
 * The raw document carries four things no client needs and one must never see:
 * the Play purchase token (a payment credential, as googlePlay.js notes),
 * `redeemedPaymentIds` (the whole replay-guard history), `retiredPlayTokens` and
 * `sentNotices` (which plan notices were already sent, see notices.js).
 * Everything else is kept as it was so no client has to change.
 */
export const toPublicSubscription = (subscription) => {
    if (!subscription) return null;
    const plain = typeof subscription.toObject === 'function'
        ? subscription.toObject()
        : { ...subscription };
    delete plain.playPurchaseToken;
    delete plain.redeemedPaymentIds;
    delete plain.retiredPlayTokens;
    delete plain.sentNotices;
    return plain;
};

/**
 * Writes an activation that the caller has already validated.
 *
 * [endDate] is the caller's to compute, because the two gateways disagree about
 * who owns that date: for Cashfree we derive it ourselves with addOneMonth,
 * whereas Google Play tells us the expiry outright and is authoritative — it
 * has already applied any proration, pause, grace period or free trial, so
 * recomputing it locally would fight the store and drift.
 *
 * Whatever Play token the row held before and no longer holds afterwards is
 * moved to `retiredPlayTokens` here, in the one place the row is rewritten, so
 * no caller can forget: a replacement purchase retires the old token, and a
 * Cashfree activation retires the Play token it displaces (and clears it, so the
 * row no longer claims to be Play-backed). [pendingPlan] / [pendingPlanAt] are a
 * scheduled switch Play reported; leaving them out clears any earlier one, which
 * is what "the switch happened" and "the user changed their mind" both need.
 */
export const persistActivation = async ({
    user,
    plan,
    startDate,
    endDate,
    paymentId,
    source,
    autoRenew = true,
    playPurchaseToken = null,
    playProductId = null,
    pendingPlan = null,
    pendingPlanAt = null
}) => {
    let subscription = await Subscription.findOne({ userId: user._id });
    const previousPlan = subscription?.plan;
    const previousStatus = subscription?.status;
    // The plan the user was actually ENTITLED to before this write, so a caller
    // can tell a plan change from a first purchase or a renewal. A lapsed row
    // does not count: there was nothing to change from. (previousPlan above is
    // the row's plan whether or not it was still running; a caller that knows a
    // lapsed row WAS the thing being switched away from uses that one.)
    const previousEntitledPlan = isEntitledNow(subscription) ? subscription.plan : null;
    // What the notices (notices.js) compare the new row against. Copied out now
    // because the document is rewritten in place below.
    const before = {
        plan: previousPlan || null,
        status: previousStatus || null,
        entitledPlan: previousEntitledPlan,
        token: subscription?.playPurchaseToken || null,
        pendingPlan: subscription?.pendingPlan || null,
        pendingPlanAt: subscription?.pendingPlanAt || null
    };

    if (subscription) {
        subscription.plan      = plan;
        subscription.status    = 'active';
        subscription.startDate = startDate;
        subscription.endDate   = endDate;
        subscription.paymentId = paymentId;
        subscription.autoRenew = autoRenew;
        if (source)            subscription.source = source;

        if (playPurchaseToken) {
            if (subscription.playPurchaseToken && subscription.playPurchaseToken !== playPurchaseToken) {
                retirePlayToken(subscription, subscription.playPurchaseToken);
            }
            // A token that becomes current cannot also sit in the retired list.
            // This is the one way a retired token comes back: Play reports it
            // live and billing again (the user resubscribed to it), which
            // googlePlay.js treats as an ordinary purchase rather than ignoring
            // a plan the user is being charged for.
            if (subscription.retiredPlayTokens?.includes(playPurchaseToken)) {
                subscription.retiredPlayTokens.pull(playPurchaseToken);
            }
            subscription.playPurchaseToken = playPurchaseToken;
        } else if (source === 'cashfree' && subscription.playPurchaseToken) {
            retirePlayToken(subscription, subscription.playPurchaseToken);
            subscription.playPurchaseToken = null;
            subscription.playProductId = null;
        }
        if (playProductId)     subscription.playProductId = playProductId;

        subscription.pendingPlan   = pendingPlan;
        subscription.pendingPlanAt = pendingPlanAt;
        await subscription.save();
        await trimRetiredPlayTokens(subscription);
    } else {
        subscription = await Subscription.create({
            userId: user._id,
            plan,
            status: 'active',
            startDate,
            endDate,
            paymentId,
            autoRenew,
            source: source || undefined,
            playPurchaseToken: playPurchaseToken || undefined,
            playProductId: playProductId || undefined,
            pendingPlan,
            pendingPlanAt
        });
    }

    const Business = (await import('../../models/business.models.js')).default;
    const business = await Business.findOneAndUpdate(
        { userId: user._id },
        { $set: { plan: PLAN_TO_BUSINESS_PLAN[plan], subscriptionStatus: 'active', isVerified: true } },
        { upsert: true, new: true }
    );

    if (needsAccountManagerAlert({ plan, previousPlan, previousStatus, business })) {
        void alertCorporateNeedsManager(user, business);
    }

    try {
        await invalidateCaches(user._id);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    // Last, and detached: the plan is already granted, and telling the user about
    // it must neither wait for nor be able to fail that. See notices.js.
    announceActivation(subscription, before);

    return { subscription, business, previousEntitledPlan, previousPlan: previousPlan || null };
};

/**
 * Makes the Business doc agree with a subscription that is paying out right now.
 *
 * The Subscription row and the Business doc are two writes, and two writers that
 * land at the same moment (the notification for a plan's end and the one for its
 * successor) can leave them disagreeing: an active, entitled row next to a
 * Business still on the free tier. Nothing else would ever fix that until the
 * next renewal a month later, so the paths that notice a plan is already applied
 * call this. A no-op when they agree, or when the subscription is not entitled.
 */
export const syncBusinessToSubscription = async (subscription) => {
    if (!isEntitledNow(subscription)) return false;
    const wanted = PLAN_TO_BUSINESS_PLAN[subscription.plan];
    if (!wanted) return false;

    const Business = (await import('../../models/business.models.js')).default;
    const business = await Business.findOne({ userId: subscription.userId })
        .select('plan subscriptionStatus')
        .lean();
    if (!business || (business.plan === wanted && business.subscriptionStatus === 'active')) return false;

    await Business.updateOne(
        { userId: subscription.userId },
        { $set: { plan: wanted, subscriptionStatus: 'active', isVerified: true } }
    );
    try {
        await invalidateCaches(subscription.userId);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }
    return true;
};

/**
 * Ends a subscription that the store says is over (expired, revoked, refunded,
 * or cancelled past its paid-through date). Downgrades the Business doc back to
 * the free tier so paid features stop working.
 *
 * The Business downgrade is the same one jobs/subscriptionExpiry.job.js uses
 * (downgradeBusinessToFree) — plan1 + subscriptionStatus 'pending', and the
 * verified tick kept only for KYC-approved businesses. Note that 'pending'
 * rather than the Subscription's own 'expired'/'cancelled' is not a slip:
 * Business.subscriptionStatus only permits active|inactive|pending, and $set in
 * an update skips validators, so writing the Subscription status through would
 * silently store a value outside the enum.
 *
 * Deliberately does not delete the Subscription: `redeemedPaymentIds` is the
 * replay guard and must survive, and the row is the only record of what the
 * user used to have.
 *
 * Compare-and-set. [subscription] was loaded some time ago, and a plan switch
 * makes two notifications arrive together: the old token ending and the new one
 * starting. If the new plan's activation lands between our read and this write,
 * a plain save() of the stale copy would still go through (it carries no version
 * check for these fields) and then downgrade the Business that the activation
 * had just raised: an active Corporate/Small Business row next to a free-tier
 * Business, which nothing would repair until the next renewal. So the row is
 * ended only if it still has the status and token we read; otherwise somebody
 * else changed it, this is no longer our decision, and null is returned without
 * touching the Business.
 *
 * [reason] only shapes the words of the "plan ended" notice: 'on_hold' or
 * 'paused' when Play ended the plan for that (a failed payment, a pause the user
 * chose), nothing for a plan that simply ran out. See announcePlanEnded.
 */
export const persistDeactivation = async ({ subscription, status = 'expired', reason }) => {
    const ended = await Subscription.findOneAndUpdate(
        {
            _id: subscription._id,
            status: subscription.status,
            playPurchaseToken: subscription.playPurchaseToken || null
        },
        // Nothing is left to switch to once the subscription itself is over.
        { $set: { status, autoRenew: false, pendingPlan: null, pendingPlanAt: null } },
        { new: true }
    );
    if (!ended) return null;

    // The plan is over, so the payment it was bought with can announce itself
    // again if Play ever reports that same order live (see reopenActivationNotice).
    reopenActivationNotice(ended);

    await downgradeBusinessToFree(ended.userId);

    // The Business write above is a second step after the row's. If an
    // activation slipped in between the two, put its plan back.
    let latest = null;
    try {
        latest = await Subscription.findOne({ _id: ended._id });
        await syncBusinessToSubscription(latest);
    } catch (syncError) {
        console.error('Could not re-check the Business plan after ending a subscription:', syncError?.message);
    }

    try {
        await invalidateCaches(ended.userId);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    // "Your plan has ended" is only true if it did end and stayed ended: not for a
    // row that was already over (nothing changed), and not when the activation
    // that slipped in above has put the user on a plan again (that one is
    // announced as the new plan). Detached, like every notice; this compare-and-set
    // already guarantees only one caller gets here for a given ending.
    if (subscription.status === 'active' && !isEntitledNow(latest)) {
        announcePlanEnded(ended, reason);
    }

    return ended;
};
