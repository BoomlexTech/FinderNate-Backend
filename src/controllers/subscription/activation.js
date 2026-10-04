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
 * Writes an activation that the caller has already validated.
 *
 * [endDate] is the caller's to compute, because the two gateways disagree about
 * who owns that date: for Cashfree we derive it ourselves with addOneMonth,
 * whereas Google Play tells us the expiry outright and is authoritative — it
 * has already applied any proration, pause, grace period or free trial, so
 * recomputing it locally would fight the store and drift.
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
    playProductId = null
}) => {
    let subscription = await Subscription.findOne({ userId: user._id });
    const previousPlan = subscription?.plan;
    const previousStatus = subscription?.status;

    if (subscription) {
        subscription.plan      = plan;
        subscription.status    = 'active';
        subscription.startDate = startDate;
        subscription.endDate   = endDate;
        subscription.paymentId = paymentId;
        subscription.autoRenew = autoRenew;
        if (source)            subscription.source = source;
        if (playPurchaseToken) subscription.playPurchaseToken = playPurchaseToken;
        if (playProductId)     subscription.playProductId = playProductId;
        await subscription.save();
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
            playProductId: playProductId || undefined
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

    return { subscription, business };
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
 */
export const persistDeactivation = async ({ subscription, status = 'expired' }) => {
    subscription.status = status;
    subscription.autoRenew = false;
    await subscription.save();

    await downgradeBusinessToFree(subscription.userId);

    try {
        await invalidateCaches(subscription.userId);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    return subscription;
};
