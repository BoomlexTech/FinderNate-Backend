import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';
import {
    getSubscriptionPurchase,
    acknowledgeSubscription,
    isGooglePlayConfigured,
    PLAY_PACKAGE_NAME
} from '../../config/googlePlay.config.js';
import {
    findRedemption,
    isEntitledNow,
    isPossiblyBillingPlaySubscription,
    isRenewingPlaySubscription,
    persistActivation,
    persistDeactivation,
    planChangeMessage,
    planRank,
    syncBusinessToSubscription,
    toPublicSubscription
} from './activation.js';
import { announceFactChanges } from './notices.js';
import {
    PaymentLogger,
    SubscriptionLogger,
    ErrorLogger,
    MetricsCollector,
    fingerprintToken
} from '../../utils/monitoring.utils.js';
import { SUBSCRIPTION_PLANS, PLAY_PRODUCT_TO_PLAN } from './plans.js';

// ─────────────────────────────────────────────────────────────────────────────
// Google Play Billing activation.
//
// Mirrors the Cashfree path in payment.js and obeys the same rule: the client
// only gets to say "please look at this purchase token". Which product it was,
// whether it is paid, when it expires and whose account it belongs to all come
// from a purchases.subscriptionsv2.get we make ourselves.
//
// What differs from Cashfree, and why:
//
//  · Expiry is Google's, not ours. Cashfree pays for one month and we compute
//    the end date with addOneMonth. Play has already applied free trials,
//    introductory offers, proration on tier changes, pauses and grace periods
//    by the time it answers, so we take lineItems[].expiryTime verbatim.
//    Recomputing locally would fight the store and drift on every edge case.
//
//  · Renewals arrive without the user. Play charges the card by itself and
//    tells us afterwards through a Real-time Developer Notification, so the
//    RTDN handler below is not an optimisation — without it a subscriber's
//    endDate would lapse a month after purchase and the nightly expiry job
//    would revoke a subscription they are still paying for.
//
//  · Acknowledgement is load-bearing. Google auto-refunds any purchase left
//    unacknowledged for three days.
//
//  · A plan change is a NEW purchase. Switching Small Business <-> Corporate
//    makes Play mint a new purchase token for the new plan and mark it with
//    `linkedPurchaseToken` = the token it replaces. We hold ONE row per user, so
//    the row follows the token chain: the new token takes over, the old one is
//    remembered in `retiredPlayTokens`, and from then on anything Play says
//    about the old token is ignored. See activateForPlayPurchase for the exact
//    precedence and reconcilePlaySubscription for how a notification is routed.
// ─────────────────────────────────────────────────────────────────────────────

/** Subscription states in which the user is entitled to the paid features. */
const ENTITLED_STATES = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
]);

/**
 * States that mean the subscription is over for good. CANCELED is deliberately
 * absent: a cancelled subscription keeps working until the period the user
 * already paid for runs out, and Play keeps reporting it as CANCELED with a
 * future expiryTime the whole time. (A CANCELED purchase whose expiryTime has
 * already passed is over too; isEndedPurchase covers that.)
 */
const ENDED_STATES = new Set([
    'SUBSCRIPTION_STATE_EXPIRED',
    'SUBSCRIPTION_STATE_ON_HOLD',
    'SUBSCRIPTION_STATE_PAUSED'
]);

const STATE_CANCELED = 'SUBSCRIPTION_STATE_CANCELED';

// Of the ended states, the two that are not "ran out": they change what the user
// is told (the plan is not gone for good, and there is something they can do).
const PLAN_ENDED_REASON = {
    SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
    SUBSCRIPTION_STATE_PAUSED: 'paused'
};

/**
 * How long after a REPLACED token's expiry we keep waiting for its successor to
 * be recorded before concluding there is none. Three days is Play's own window
 * for acknowledging a purchase, so a successor that has not appeared by then was
 * never going to be granted. See the `replaced` handling in reconcile.
 */
const REPLACED_TOKEN_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How long a plan that has JUST expired is given before reconcile ends the row.
 *
 * A plan change makes two things happen at the same instant: the old token ends
 * and the new one starts. Pub/Sub does not promise to deliver the two
 * notifications in order, so "the row's token expired" is, for a few minutes
 * after the expiry, as likely to mean "it was switched for another" as "the user
 * is gone". Ending the row straight away flickered a paying user to Free (verified
 * tick and Business plan dropped, account-manager alert fired) until the
 * successor's notification arrived, and if that one was lost nothing would repair
 * it. Waiting keeps the row as it is; the successor's notification (or the app's
 * verify) takes it over, and if nothing ever arrives the nightly job, which looks
 * at every active row whose endDate has passed, ends it on its next run.
 * Not applied to ON_HOLD or PAUSED: those are not "replaced by something else".
 */
const SUCCESSOR_WAIT_MS = 15 * 60 * 1000;

const firstLineItem = (purchase) =>
    Array.isArray(purchase?.lineItems) && purchase.lineItems.length > 0
        ? purchase.lineItems[0]
        : null;

/**
 * Everything we are willing to believe about a purchase, pulled out of the
 * Play response and validated. Throws ApiError on anything unusable.
 *
 * Field names are from Google's purchases.subscriptionsv2 reference
 * (SubscriptionPurchaseV2 / SubscriptionPurchaseLineItem): `linkedPurchaseToken`
 * is top-level, `deferredItemReplacement.productId` and `latestSuccessfulOrderId`
 * live on the line item.
 */
const readPurchase = (purchase) => {
    const lineItem = firstLineItem(purchase);
    if (!lineItem) {
        throw new ApiError(400, 'Google Play returned a purchase with no line items');
    }

    const productId = lineItem.productId;
    const plan = PLAY_PRODUCT_TO_PLAN[productId];
    if (!plan) {
        throw new ApiError(400, `Unrecognised Google Play product: ${productId}`);
    }

    const expiryTime = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
    if (!expiryTime || Number.isNaN(expiryTime.getTime())) {
        throw new ApiError(400, 'Google Play returned a purchase with no usable expiry time');
    }

    // The receipt id, and our replay key. It changes on every renewal, so each
    // renewal is redeemable exactly once while an old one stays spent.
    //
    // v2 puts it on the line item (latestSuccessfulOrderId). The top-level
    // latestOrderId this code used to read is not part of Google's current v2
    // resource, so it is only a fallback for responses that still carry it.
    const orderId = lineItem.latestSuccessfulOrderId || purchase?.latestOrderId;
    if (!orderId) {
        throw new ApiError(400, 'Google Play returned a purchase with no order id');
    }

    // A change the user has already scheduled (a deferred downgrade): Play keeps
    // the current product until the period ends and names the next one here.
    // Only meaningful when it is a different plan we recognise.
    const deferredPlan = PLAY_PRODUCT_TO_PLAN[lineItem?.deferredItemReplacement?.productId] || null;

    return {
        plan,
        productId,
        expiryTime,
        orderId,
        state: purchase?.subscriptionState,
        startTime: purchase?.startTime ? new Date(purchase.startTime) : new Date(),
        autoRenewing: Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled),
        acknowledged: purchase?.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        obfuscatedAccountId:
            purchase?.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
        // The token this purchase replaces (an upgrade, a downgrade, or a
        // re-signup of a cancelled-but-unexpired subscription).
        linkedPurchaseToken: purchase?.linkedPurchaseToken || null,
        pendingPlan: deferredPlan && deferredPlan !== plan ? deferredPlan : null,
        // True when Play says THIS token was ended because a new subscription
        // replaced it. Such a token never carries entitlement again.
        replaced: Boolean(purchase?.canceledStateContext?.replacementCancellation)
    };
};

/**
 * Is the user entitled to what [details] describe, right now?
 *
 * ACTIVE and IN_GRACE_PERIOD, and also CANCELED while paid time remains: a user
 * who has switched renewal off keeps what they paid for until the period ends,
 * and the app replays such a purchase on every start (restorePurchases), so
 * refusing it would answer 400 on every launch for the rest of the month. A
 * replaced token is never entitled — its successor is what holds the plan.
 */
const isEntitledPurchase = (details, now = new Date()) =>
    !details.replaced &&
    (ENTITLED_STATES.has(details.state) ||
        (details.state === STATE_CANCELED && details.expiryTime > now));

/**
 * Is Play going to charge for [details] again? ACTIVE or in grace, with renewal
 * on, and not a token that was replaced. This is "live and billing", the test a
 * retired token has to fail to stay retired.
 */
const isRenewingPurchase = (details) =>
    !details.replaced && ENTITLED_STATES.has(details.state) && details.autoRenewing;

/** Over for good: an ended state, or CANCELED with no paid time left. */
const isEndedPurchase = (details, now = new Date()) =>
    ENDED_STATES.has(details.state) ||
    (details.state === STATE_CANCELED && details.expiryTime <= now);

const sameTime = (a, b) =>
    (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/**
 * Brings the facts Play owns up to date on a row that already points at this
 * token, without re-running the whole activation (Business upsert, cache sweep).
 *
 * This is what makes the same receipt useful twice: the order id of a
 * subscription does not change when the user switches renewal back on
 * (RESTARTED) or schedules a downgrade, so the "already redeemed" guard used to
 * answer "already active" and throw the new information away.
 */
const refreshPlayFacts = async (subscription, details) => {
    const pendingPlanAt = details.pendingPlan ? details.expiryTime : null;
    let changed = false;
    // For the notices below: what the user was told the plan looked like.
    const before = {
        autoRenew: subscription.autoRenew,
        pendingPlan: subscription.pendingPlan || null,
        pendingPlanAt: subscription.pendingPlanAt || null
    };

    if (subscription.autoRenew !== details.autoRenewing) {
        subscription.autoRenew = details.autoRenewing;
        changed = true;
    }
    if (!sameTime(subscription.endDate, details.expiryTime)) {
        subscription.endDate = details.expiryTime;
        changed = true;
    }
    if ((subscription.pendingPlan || null) !== details.pendingPlan) {
        subscription.pendingPlan = details.pendingPlan;
        changed = true;
    }
    if (!sameTime(subscription.pendingPlanAt, pendingPlanAt)) {
        subscription.pendingPlanAt = pendingPlanAt;
        changed = true;
    }

    if (changed) {
        await subscription.save();
        // This is the one place Play turning renewal off, or scheduling a
        // downgrade, is written, so it is where the user is told. Detached; see
        // notices.js for why two callers seeing the same change still send once.
        announceFactChanges(subscription, before, { cancelled: details.state === STATE_CANCELED });
    }
    return changed;
};

/**
 * Has this token been replaced, as far as the user's row knows?
 * (Either Play says so, or we already retired it.)
 *
 * A retired token stays retired only while it is dead. Retirement is by our
 * bookkeeping, not Play's word: a token is also retired when a website purchase
 * takes the row over, and the user can still resubscribe to that Play plan. If
 * Play now reports the token live and renewing, it is being billed, and ignoring
 * it would leave the user charged by Play for a plan we no longer listen to. A
 * token that was upgraded or downgraded away never looks like that: Play marks
 * it replaced or ended.
 */
const isSupersededToken = (subscription, details, purchaseToken) =>
    details.replaced ||
    (Boolean(subscription?.retiredPlayTokens?.includes(purchaseToken)) && !isRenewingPurchase(details));

/**
 * Will the Play plan on [subscription] really bill again? Asks Play rather than
 * trusting our copy.
 *
 * Both double-billing guards (a Cashfree order, and a Play purchase that is not
 * an upgrade/downgrade of the current plan) used to rest on the stored
 * `autoRenew` flag alone. That flag is only as fresh as the last notification:
 * a user who has just cancelled in Play, or whose upgrade's replacement flag we
 * have not seen, was refused a purchase they had every right to make, and a Play
 * purchase refused that way is never acknowledged, so Play refunds it three days
 * later. So the row says "maybe", and Play decides.
 *
 * When Play cannot be asked, only a row that is entitled right now is believed to
 * be renewing: blocking a user on a guess about a plan that has already run out
 * would be worse than the double-billing the guard exists to prevent.
 */
export const playRowStillRenews = async (subscription) => {
    if (!isPossiblyBillingPlaySubscription(subscription)) return false;
    const storedSaysRenewing = isRenewingPlaySubscription(subscription);
    if (!isGooglePlayConfigured()) return storedSaysRenewing;

    let details;
    try {
        details = readPurchase(await getSubscriptionPurchase(subscription.playPurchaseToken));
    } catch (error) {
        ErrorLogger.logPaymentGatewayError(String(subscription.userId), null, error);
        return storedSaysRenewing;
    }

    if (isRenewingPurchase(details)) return true;

    // Play says it will not charge again. Correct our copy while we are here so
    // the clients stop offering "renews" for it. Best effort.
    if (!details.replaced && isEntitledPurchase(details)) {
        try {
            await refreshPlayFacts(subscription, details);
        } catch (refreshError) {
            console.warn('[Play] Could not refresh a stale subscription row:', refreshError?.message);
        }
    }
    return false;
};

/**
 * Does Play say [subscription] (a row we store as NOT renewing) is renewing after
 * all? For the "your plan ends soon" reminder, which must never go to a plan that
 * will renew: the user can switch renewal back on in Play and, if that
 * notification and the app's verify call both missed us, our copy still says
 * cancelled.
 *
 * playRowStillRenews asks the same question for rows we store as renewing and
 * answers false at once for these, so it cannot be reused. When Play does say it
 * renews, our copy is corrected on the spot (autoRenew, endDate), which also
 * stops the reminder query from picking the row up again.
 *
 * True only on Play's word. When Play cannot be asked (not configured, a failed
 * call) this is false and the reminder goes out on what the row says: a missing
 * reminder is the worse mistake for a plan that really is ending.
 */
export const playConfirmsRenewal = async (subscription) => {
    if (!subscription?.playPurchaseToken || !isGooglePlayConfigured()) return false;

    let details;
    try {
        details = readPurchase(await getSubscriptionPurchase(subscription.playPurchaseToken));
    } catch (error) {
        ErrorLogger.logPaymentGatewayError(String(subscription.userId), null, error);
        return false;
    }
    if (!isRenewingPurchase(details)) return false;

    try {
        await refreshPlayFacts(subscription, details);
    } catch (refreshError) {
        console.warn('[Play] Could not refresh a row Play says renews:', refreshError?.message);
    }
    return true;
};

/**
 * Grants [details] to [user] and tells Play we have done so.
 *
 * Shared by the client-driven verify call and the RTDN handler, so whichever
 * arrives first wins and the second is a no-op — the redemption guard keys on
 * the order id, exactly as the Cashfree path does.
 *
 * The user has ONE subscription row, so a token that arrives has to be placed
 * against whatever that row already holds. In order:
 *
 *  1. The row's own token. A renewal (new order id) re-activates in full; the
 *     same order id again only refreshes autoRenew / endDate / pending switch,
 *     which is how a RESTARTED subscription and a scheduled downgrade are seen.
 *  2. A token whose `linkedPurchaseToken` is the row's token: Play's own marker
 *     for "this replaces that one". It takes over; the old token is retired.
 *  3. A token we already retired AND Play reports dead (replaced, ended,
 *     cancelled): ignored. It is not granted, not revoked, and not acknowledged,
 *     so a late notification about an old plan can neither flip the row back nor
 *     switch the new plan off. A retired token Play reports LIVE and renewing is
 *     not ignored: the user is being charged for it, so it goes on to 4 / 5 like
 *     any other purchase (and is logged, because it means two things bill).
 *  4. Any other token while the row is a Play plan that really renews: refused
 *     with 409 and NOT acknowledged. Accepting it would leave two live Play
 *     subscriptions billing the user, with the row following whichever spoke
 *     last. Play refunds the unacknowledged purchase after three days, which is
 *     the right outcome for a purchase that should not exist. "Really renews" is
 *     asked of Play (playRowStillRenews), not read from our copy, so a
 *     replacement that arrives without `linkedPurchaseToken`, or a renewal the
 *     user has just switched off, is not refused on stale data.
 *  5. Anything else — no row, a lapsed row, a Cashfree row, or a Play plan that
 *     will not bill again — is a plain activation, and persistActivation retires
 *     whatever Play token the row held. One exception, to protect what the user
 *     paid for on the website: a Play purchase that is already cancelled and is
 *     no better than the running website plan (same or lower tier, ending no
 *     later) is only acknowledged. The app replays every purchase it owns at each
 *     start, and a restore must not trade a longer or higher paid plan for it. It
 *     is applied normally once the website plan has run out.
 */
const activateForPlayPurchase = async (args) => {
    try {
        return await applyPlayPurchase(args);
    } catch (error) {
        // The app's verify and Play's notification for the same new token arrive
        // within seconds of each other, both read the row, and both write it. The
        // loser fails on the row's version (or, for a brand-new user, on the
        // unique userId) AFTER the user has paid. Running it again re-reads the
        // row, finds the winner's work and lands on the "already applied" branch.
        if (error?.name === 'VersionError' || error?.code === 11000) {
            return applyPlayPurchase(args);
        }
        throw error;
    }
};

const applyPlayPurchase = async ({ user, details, purchaseToken }) => {
    const existing = await findRedemption([details.orderId]);
    if (existing && existing.userId.toString() !== user._id.toString()) {
        throw new ApiError(400, 'This purchase has already been used to activate a subscription');
    }

    // The user has a single row, so a redemption by this user IS that row.
    const record = existing || await Subscription.findOne({ userId: user._id });

    let subscription = record;
    let alreadyApplied = false;
    let keptWebsitePlan = false;
    let previousPlan = null;

    const isOwnToken = Boolean(record?.playPurchaseToken) && record.playPurchaseToken === purchaseToken;
    const replacesOwnToken =
        Boolean(record?.playPurchaseToken) &&
        Boolean(details.linkedPurchaseToken) &&
        details.linkedPurchaseToken === record.playPurchaseToken;
    const isRetired = Boolean(record?.retiredPlayTokens?.includes(purchaseToken));
    const retiredButLive = isRetired && isRenewingPurchase(details);
    // The plan being moved away from, for the success message. It is the row's
    // plan even when that plan has already run out: a scheduled downgrade lands
    // exactly at the end of the old period, so by then the old plan is no longer
    // "entitled" but is still what the user switched down from.
    const isPlanSwitch =
        replacesOwnToken || (Boolean(record?.pendingPlan) && record.pendingPlan === details.plan);

    const activate = async () => {
        const result = await persistActivation({
            user,
            plan: details.plan,
            startDate: details.startTime,
            endDate: details.expiryTime,
            paymentId: details.orderId,
            source: 'google_play',
            autoRenew: details.autoRenewing,
            playPurchaseToken: purchaseToken,
            playProductId: details.productId,
            pendingPlan: details.pendingPlan,
            pendingPlanAt: details.pendingPlan ? details.expiryTime : null
        });
        subscription = result.subscription;
        previousPlan = result.previousEntitledPlan || (isPlanSwitch ? result.previousPlan : null);
    };

    if (retiredButLive) {
        console.warn(
            `⚠️ Retired Google Play token is live and renewing again for user ${user._id} ` +
            `(${fingerprintToken(purchaseToken)}): Play is billing a plan the row had moved away from`
        );
    }

    if (isOwnToken) {
        // 1. The row's own token.
        if (existing && record.status === 'active' && record.plan === details.plan) {
            // Same receipt as before: nothing to grant, but Play may have new
            // facts about it, and a notification pair that raced may have left
            // the Business doc behind the row.
            await refreshPlayFacts(record, details);
            await syncBusinessToSubscription(record);
            alreadyApplied = true;
        } else {
            // A renewal, or a row that had been switched off and Play now
            // reports as live again.
            await activate();
        }
    } else if (replacesOwnToken) {
        // 2. Play says this replaces the plan the row holds.
        await activate();
    } else if (isRetired && !retiredButLive) {
        // 3. A replaced token. Hands off — and no acknowledgement either.
        return { subscription: record, alreadyApplied: true, ignored: true, kept: false, previousPlan: null };
    } else if (await playRowStillRenews(record)) {
        // 4. A second, unrelated Play subscription on top of a renewing one.
        throw new ApiError(
            409,
            'You already have a plan that renews through Google Play. Use Upgrade or Downgrade to change it.'
        );
    } else if (existing && !retiredButLive) {
        // Same user, same receipt, but not the token the row points at and not
        // linked to it. Treat it as already granted, as this always has.
        alreadyApplied = true;
    } else if (websitePlanCovers(record, details)) {
        // 5, the exception: keep the website plan, still acknowledge.
        alreadyApplied = true;
        keptWebsitePlan = true;
    } else {
        // 5. Nothing to conflict with.
        await activate();
    }

    // Acknowledge even when the grant was already applied: it may have been
    // written on a previous attempt that died before it could acknowledge, and
    // an unacknowledged purchase is auto-refunded after three days.
    if (!details.acknowledged) {
        try {
            await acknowledgeSubscription({
                subscriptionId: details.productId,
                purchaseToken
            });
        } catch (ackError) {
            // Loud, because the consequence is silent and delayed: Play will
            // refund the user in three days and we will look like we took their
            // money for nothing.
            ErrorLogger.logPaymentGatewayError(
                user._id.toString(),
                details.orderId,
                new Error(`Play acknowledgement FAILED (auto-refund in 3 days): ${ackError?.message || ackError}`)
            );
        }
    }

    return { subscription, alreadyApplied, ignored: false, kept: keptWebsitePlan, previousPlan };
};

/**
 * Is [record] a website plan that is running now and already at least as good as
 * the cancelled Play purchase [details]? See case 5 of activateForPlayPurchase.
 * A purchase that still renews is never "covered": it is a real subscription.
 */
const websitePlanCovers = (record, details, now = new Date()) =>
    record?.source === 'cashfree' &&
    isEntitledNow(record, now) &&
    !details.autoRenewing &&
    planRank(record.plan) >= planRank(details.plan) &&
    new Date(record.endDate) >= details.expiryTime;

/**
 * What a verify/sync answer says about the user's plan, in the same shape the
 * Cashfree verify answer has so the clients can read both the same way.
 */
const buildVerifyResponse = async ({ userId, subscription, plan, message, paymentId, ignored = false }) => {
    const Business = (await import('../../models/business.models.js')).default;
    const businessDoc = await Business.findOne({ userId });

    const hasCallingAccess = ['small_business', 'corporate'].includes(plan);

    return {
        subscription: toPublicSubscription(subscription),
        business: { plan: businessDoc?.plan, subscriptionStatus: businessDoc?.subscriptionStatus },
        tier: plan,
        features: {
            calling: {
                hasAccess: hasCallingAccess,
                audioCall: hasCallingAccess,
                videoCall: hasCallingAccess,
                unlimited: hasCallingAccess
            }
        },
        message,
        paymentId,
        ignored
    };
};

/**
 * POST /api/v1/subscription/google-play/verify   { purchaseToken }
 *
 * Called by the app after Play reports a completed purchase, and again on every
 * app start for any purchase the client still holds unfinished. Idempotent.
 */
export const verifyGooglePlayPurchase = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { purchaseToken } = req.body;

    if (!purchaseToken || typeof purchaseToken !== 'string') {
        throw new ApiError(400, 'Missing required field: purchaseToken');
    }
    if (!isGooglePlayConfigured()) {
        throw new ApiError(503, 'Google Play billing is not configured on this server');
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isBusinessProfile) {
        throw new ApiError(403, 'Only business accounts can activate a subscription.');
    }

    let purchase;
    try {
        purchase = await getSubscriptionPurchase(purchaseToken);
    } catch (error) {
        ErrorLogger.logPaymentGatewayError(userId.toString(), null, error);
        // A 404 from Play means the token is not a purchase it knows about.
        if (error?.response?.status === 404) {
            throw new ApiError(400, 'Google Play does not recognise this purchase');
        }
        throw new ApiError(502, 'Could not verify the purchase with Google Play');
    }

    const details = readPurchase(purchase);
    const current = await Subscription.findOne({ userId });

    // ── Did the account being upgraded pay for it? ────────────────────────────
    // The app sets this to the buyer's userId at purchase time; it is the Play
    // equivalent of Cashfree's customer_id. Missing means the purchase was made
    // by something that is not our app, so refuse rather than fall back to a
    // weaker check — otherwise one purchase token could be passed around and
    // redeemed by any number of accounts.
    //
    // One exception, and it is narrow: a replacement purchase is tied to the
    // plan it replaces by Play itself (linkedPurchaseToken), and that older
    // token is one this account already proved it owns. A replacement that came
    // back without the account id is therefore still this user's.
    if (!details.obfuscatedAccountId) {
        const replacesOwnPlan =
            Boolean(details.linkedPurchaseToken) &&
            Boolean(current?.playPurchaseToken) &&
            details.linkedPurchaseToken === current.playPurchaseToken;
        if (!replacesOwnPlan) {
            throw new ApiError(400, 'This purchase is not linked to a Findernate account');
        }
    } else if (details.obfuscatedAccountId !== userId.toString()) {
        throw new ApiError(403, 'This purchase belongs to a different account');
    }

    // The purchase token is a payment credential and these loggers append to a
    // file on a persistent disk, so only its fingerprint goes to the log.
    const entitled = isEntitledPurchase(details);
    PaymentLogger.logPaymentVerification(
        userId.toString(),
        details.orderId,
        fingerprintToken(purchaseToken),
        entitled
    );

    // A token that was replaced is not an error and not a grant: the app replays
    // whatever it still holds, and answering 400 would show the user a failure
    // for a plan change that went fine. Tell it plainly and change nothing.
    if (isSupersededToken(current, details, purchaseToken)) {
        const stillEntitled = isEntitledNow(current);
        res.status(200).json(
            new ApiResponse(200, await buildVerifyResponse({
                userId,
                subscription: current,
                plan: stillEntitled ? current.plan : 'free',
                message: 'That purchase was replaced by a newer plan, so nothing was changed.',
                paymentId: details.orderId,
                ignored: true
            }), 'Purchase already replaced')
        );
        return;
    }

    if (!entitled) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Purchase is not active. Google Play reports: ${details.state || 'unknown'}`);
    }

    const { subscription, alreadyApplied, kept, previousPlan } =
        await activateForPlayPurchase({ user, details, purchaseToken });

    // A cancelled Play purchase the website plan already covers: acknowledged,
    // not applied. Say what the user's plan really is, not what the purchase was.
    if (kept) {
        res.status(200).json(
            new ApiResponse(200, await buildVerifyResponse({
                userId,
                subscription,
                plan: isEntitledNow(subscription) ? subscription.plan : 'free',
                message: 'Your current plan already covers this purchase, so nothing was changed.',
                paymentId: details.orderId,
                ignored: true
            }), 'Purchase already covered')
        );
        return;
    }

    const planName = SUBSCRIPTION_PLANS[details.plan]?.name || details.plan;

    if (!alreadyApplied) {
        PaymentLogger.logPaymentSuccess(
            userId.toString(), details.orderId, fingerprintToken(purchaseToken),
            details.plan, SUBSCRIPTION_PLANS[details.plan]?.price ?? 0
        );
        SubscriptionLogger.logSubscriptionCreated(
            userId.toString(), details.plan, subscription.startDate, subscription.endDate
        );
        MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[details.plan]?.price ?? 0, details.plan);
    }

    const message = planChangeMessage({
        planName, plan: details.plan, previousPlan, alreadyApplied
    });

    res.status(200).json(
        new ApiResponse(200, await buildVerifyResponse({
            userId,
            subscription,
            plan: details.plan,
            message,
            paymentId: details.orderId
        }), 'Subscription activated successfully')
    );
});

/**
 * POST /api/v1/subscription/google-play/sync
 *
 * Re-reads the caller's CURRENT Play subscription from Play and makes the row
 * match. The app calls it right after it schedules a deferred downgrade: Play is
 * not guaranteed to notify us about that promptly, and without it the status
 * screen would not show "switching to X on DATE" until the next notification or
 * the nightly job.
 *
 * Takes nothing from the body — the token is the one already on the user's row —
 * so it can neither be pointed at somebody else's purchase nor be used to
 * activate a new one (that is what verify is for). Never returns a token.
 */
export const syncGooglePlaySubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    if (!isGooglePlayConfigured()) {
        throw new ApiError(503, 'Google Play billing is not configured on this server');
    }

    // Looked up whatever its status: a row that was switched off by mistake is
    // exactly what a sync should be able to put right.
    const subscription = await Subscription.findOne({ userId });
    if (!subscription || subscription.source !== 'google_play' || !subscription.playPurchaseToken) {
        return res.status(200).json(
            new ApiResponse(200, { reconciled: false }, 'No Google Play subscription to sync')
        );
    }

    let result;
    try {
        result = await reconcilePlaySubscription(subscription.playPurchaseToken);
    } catch (error) {
        if (error instanceof ApiError) throw error;
        ErrorLogger.logPaymentGatewayError(userId.toString(), null, error);
        throw new ApiError(502, 'Could not reach Google Play. Please try again in a moment.');
    }

    return res.status(200).json(
        new ApiResponse(200, { reconciled: Boolean(result?.reconciled) }, 'Subscription synced with Google Play')
    );
});

/**
 * POST /api/v1/subscription/google-play/notification
 *
 * Google Cloud Pub/Sub push endpoint for Real-time Developer Notifications.
 * Set the RTDN topic in Play Console > Monetise with Play > Monetisation setup,
 * then create a PUSH subscription on that topic pointing here.
 *
 * Authentication is a shared secret carried in the push URL's query string
 * (?token=…, matched against GOOGLE_PLAY_RTDN_SECRET), which is the mechanism
 * Google documents for push endpoints that are not behind IAP. It is the only
 * authentication this route has — the route is deliberately mounted before the
 * JWT middleware, because Pub/Sub has no user session.
 *
 * The notification type is deliberately ignored for deciding entitlement. Play
 * ships nearly twenty of them and treating each as an instruction is how these
 * integrations rot; instead any notification is treated purely as a nudge to
 * re-read the subscription and reconcile to whatever Play now says.
 *
 * Always answers 200. A non-2xx makes Pub/Sub redeliver, and a payload we
 * cannot use will not become usable on the fourth attempt.
 */
export const googlePlayNotification = asyncHandler(async (req, res) => {
    const expected = process.env.GOOGLE_PLAY_RTDN_SECRET;
    if (!expected || req.query?.token !== expected) {
        // 403 rather than 200: this one is not a bad payload, it is an
        // unauthenticated caller, and Pub/Sub is not the one being turned away.
        return res.status(403).json({ success: false });
    }

    const encoded = req.body?.message?.data;
    if (!encoded) return res.status(200).json({ success: true });

    let notification;
    try {
        notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
        console.error('[Play RTDN] Could not decode message data');
        return res.status(200).json({ success: true });
    }

    // Test notifications are sent from Play Console's "Send test notification"
    // button and carry no purchase.
    if (notification?.testNotification) {
        console.log('[Play RTDN] Test notification received');
        return res.status(200).json({ success: true });
    }

    if (notification?.packageName && notification.packageName !== PLAY_PACKAGE_NAME) {
        console.warn(`[Play RTDN] Ignoring notification for ${notification.packageName}`);
        return res.status(200).json({ success: true });
    }

    const sub = notification?.subscriptionNotification;
    const purchaseToken = sub?.purchaseToken;
    if (!purchaseToken) return res.status(200).json({ success: true });

    try {
        await reconcilePlaySubscription(purchaseToken);
    } catch (error) {
        // Swallowed on purpose — see the 200 note above. Surfaced for
        // reconciliation instead of being retried into a loop.
        ErrorLogger.logPaymentGatewayError('play-rtdn', fingerprintToken(purchaseToken), error);
        console.error('[Play RTDN] Reconciliation failed:', error?.message || error);
    }

    return res.status(200).json({ success: true });
});

/**
 * Re-reads one subscription from Play and makes our records match it.
 *
 * Used by the RTDN handler, the sync endpoint and the nightly expiry job, and
 * safe to call from a reconciliation script.
 *
 * Whose token is this? Looked up in this order, and the order is the point:
 *
 *  1. A row whose CURRENT token it is. The normal case.
 *  2. A row that RETIRED it. The token was replaced; whatever Play says about it
 *     (cancelled, expired, replaced) must not touch the row, so this returns
 *     without activating or deactivating anything. The exception is a retired
 *     token Play reports live and renewing: the user is being billed for it, so
 *     it carries on to activateForPlayPurchase like any other purchase.
 *  3. A row whose current token is this purchase's `linkedPurchaseToken`: this
 *     token is the SUCCESSOR of that plan. Found this way the new plan is
 *     granted without the app being open — the deferred downgrade that takes
 *     effect at renewal arrives exactly like this.
 *  4. The account id Play carries, which covers a purchase that arrives before
 *     the client has ever verified.
 */
export const reconcilePlaySubscription = async (purchaseToken) => {
    const purchase = await getSubscriptionPurchase(purchaseToken);
    const details = readPurchase(purchase);
    const now = new Date();

    // 1. The row's current token.
    let subscription = await Subscription.findOne({ playPurchaseToken: purchaseToken });
    const matchedCurrent = Boolean(subscription);

    if (!subscription) {
        // 2. A token the row replaced.
        const retiredBy = await Subscription.findOne({ retiredPlayTokens: purchaseToken });
        if (retiredBy && !isRenewingPurchase(details)) {
            return { reconciled: true, state: details.state, active: false, ignored: true };
        }
        // Retired but live and billing again (the user resubscribed to it): it
        // is not "an old plan", it is one they are being charged for. Carry on
        // with its owner and let activateForPlayPurchase place it (and log it).
        if (retiredBy) subscription = retiredBy;

        // 3. The successor of the plan a row holds.
        if (!subscription && details.linkedPurchaseToken) {
            const predecessor = await Subscription.findOne({ playPurchaseToken: details.linkedPurchaseToken });
            // The link is Play's, so it cannot be forged — but if the purchase
            // names a different account than the row's owner, trust the account.
            const sameOwner =
                predecessor &&
                (!details.obfuscatedAccountId ||
                    details.obfuscatedAccountId === predecessor.userId.toString());
            if (sameOwner) subscription = predecessor;
        }
    }

    // 4. Otherwise whoever Play says bought it.
    let user = null;
    if (subscription) {
        user = await User.findById(subscription.userId);
    } else if (details.obfuscatedAccountId) {
        user = await User.findById(details.obfuscatedAccountId).catch(() => null);
    }

    if (!user) {
        // Nothing to attribute it to yet. The client's own verify call will
        // pick it up the next time the app opens.
        console.warn(`[Play RTDN] No account for purchase token (state ${details.state})`);
        return { reconciled: false };
    }

    // A token Play itself says was replaced never carries entitlement again, so
    // it must neither activate nor deactivate — its successor is the plan. The
    // one exception is bounded: if this is still the row's current token and the
    // successor has not been recorded within Play's three-day window, the row is
    // left pointing at a plan that ended, so end it rather than reconcile it
    // forever.
    if (details.replaced) {
        if (
            matchedCurrent &&
            subscription.status === 'active' &&
            details.expiryTime.getTime() + REPLACED_TOKEN_WAIT_MS <= now.getTime()
        ) {
            await persistDeactivation({ subscription, status: 'expired' });
            return { reconciled: true, state: details.state, active: false, replaced: true };
        }
        return { reconciled: true, state: details.state, active: isEntitledNow(subscription), replaced: true };
    }

    if (isEntitledPurchase(details, now)) {
        const { alreadyApplied, ignored } =
            await activateForPlayPurchase({ user, details, purchaseToken });
        if (!alreadyApplied && !ignored) {
            SubscriptionLogger.logSubscriptionCreated(
                user._id.toString(), details.plan, details.startTime, details.expiryTime
            );
        }
        return { reconciled: true, state: details.state, active: !ignored };
    }

    if (isEndedPurchase(details, now)) {
        // Only the row that holds THIS token is ended by it. A token found by
        // its link, or by account id, is not what the row's plan stands on.
        if (matchedCurrent && subscription.status === 'active') {
            // An expiry in the last few minutes may be one half of a plan switch
            // whose other half (the successor's notification) has not been
            // processed yet. Leave the row for it; see SUCCESSOR_WAIT_MS.
            const mayHaveSuccessor =
                (details.state === 'SUBSCRIPTION_STATE_EXPIRED' || details.state === STATE_CANCELED) &&
                now.getTime() - details.expiryTime.getTime() < SUCCESSOR_WAIT_MS;
            if (mayHaveSuccessor) {
                return { reconciled: true, state: details.state, active: false, waiting: true };
            }
            await persistDeactivation({
                subscription,
                status: 'expired',
                reason: PLAN_ENDED_REASON[details.state]
            });
        }
        return { reconciled: true, state: details.state, active: false };
    }

    // PENDING, PENDING_PURCHASE_CANCELED and anything Play adds later: nothing
    // has been granted or taken away. Record Play's current numbers on the row
    // that holds this token, if any, and do not revoke anything.
    if (matchedCurrent && subscription.status === 'active') {
        subscription.autoRenew = details.autoRenewing;
        subscription.endDate = details.expiryTime;
        await subscription.save();
    }
    return { reconciled: true, state: details.state, active: true };
};
