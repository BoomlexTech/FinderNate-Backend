import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';
import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
} from '../../config/cashfree.config.js';
import { requireCashfreeWebhookSignature } from '../../utils/cashfreeWebhook.utils.js';
import {
    PaymentLogger,
    SubscriptionLogger,
    ErrorLogger,
    MetricsCollector
} from '../../utils/monitoring.utils.js';
import { SUBSCRIPTION_PLANS, isPlanComingSoon } from './plans.js';
// The renewal arithmetic, the Business-plan mapping, the cache sweep and the
// redemption guard now live in activation.js and are shared with the Google
// Play path — the same "keep it as one definition" rule the Razorpay drift
// taught, now that there genuinely is a second activation path again.
import {
    addOneMonth,
    findRedemption,
    isPossiblyBillingPlaySubscription,
    isRenewingPlaySubscription,
    persistActivation,
    planChangeMessage,
    toPublicSubscription
} from './activation.js';
import { playRowStillRenews } from './googlePlay.js';

// Which plan a Cashfree order was actually for. Derived from the order note we
// set at creation time, falling back to the amount paid — never from the client.
const resolvePlanFromCashfreeOrder = (cfOrder) => {
    const note = String(cfOrder?.order_note || '');
    const paidPlans = Object.entries(SUBSCRIPTION_PLANS).filter(([, p]) => p.price > 0);

    const byNote = paidPlans.find(([, p]) => note.includes(p.name));
    if (byNote) return byNote[0];

    const paidAmount = Number(cfOrder?.order_amount);
    const byPrice = paidPlans.filter(([, p]) => p.price === paidAmount);
    return byPrice.length === 1 ? byPrice[0][0] : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Single activation path, shared by the success-page verify call and the S2S
// webhook. Everything it trusts comes from the Cashfree order we fetched
// ourselves: which plan was bought, how much was actually paid, and which
// account paid it. The client only ever gets to say "please check this order".
// ─────────────────────────────────────────────────────────────────────────────
const activateSubscriptionForOrder = async ({ cfOrder, cfPaymentId, expectedUserId = null, expectedPlan = null }) => {
    // ── Which plan did this payment actually buy? ─────────────────────────────
    const plan = resolvePlanFromCashfreeOrder(cfOrder);
    if (!plan) {
        throw new ApiError(400, 'Could not determine which subscription plan this payment was for');
    }
    const planDetails = SUBSCRIPTION_PLANS[plan];

    if (expectedPlan && expectedPlan !== plan) {
        throw new ApiError(400,
            `This payment was for the ${planDetails.name} plan. Pay for the ${SUBSCRIPTION_PLANS[expectedPlan]?.name || expectedPlan} plan to activate it.`
        );
    }

    // ── Was the plan's price actually paid? ───────────────────────────────────
    const paidAmount = Number(cfOrder?.order_amount);
    if (!Number.isFinite(paidAmount) || paidAmount + 0.01 < planDetails.price) {
        throw new ApiError(400,
            `Amount paid (₹${Number.isFinite(paidAmount) ? paidAmount : 0}) does not cover the ${planDetails.name} plan price (₹${planDetails.price})`
        );
    }

    // ── Did the account being upgraded pay for it? ────────────────────────────
    // customer_id is set to the buyer's userId when the order is created.
    const payerId = cfOrder?.customer_details?.customer_id;
    if (!payerId) {
        throw new ApiError(400, 'Payment is missing customer details - cannot attribute it to an account');
    }
    if (expectedUserId && payerId.toString() !== expectedUserId.toString()) {
        throw new ApiError(403, 'This payment belongs to a different account');
    }

    const user = await User.findById(payerId);
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.isBusinessProfile) throw new ApiError(403, 'Only business accounts can activate a subscription.');

    const subscription = await Subscription.findOne({ userId: user._id });

    // ── One payment, one activation ───────────────────────────────────────────
    // Without this the same cashfreeOrderId could be replayed every month for a
    // free renewal, or handed to a friend for a free subscription.
    // Match on the gateway payment id AND the order id: when Cashfree's
    // payments lookup fails the caller falls back to the order id, and the two
    // must not be redeemable as if they were separate payments.
    //
    // findRedemption searches redeemedPaymentIds — the full history — and not
    // just the scalar paymentId this used to query. paymentId is overwritten by
    // every renewal, so the old check went blind to any receipt older than the
    // most recent one, and a Cashfree order stays PAID forever: after a single
    // renewal the previous order id could be re-posted for another free month,
    // indefinitely. That is precisely the hole redeemedPaymentIds was added to
    // close, and the guard now actually reads it.
    const redemptionKeys = [cfPaymentId, cfOrder?.order_id].filter(Boolean).map(String);
    const redeemedBy = await findRedemption(redemptionKeys);
    if (redeemedBy) {
        if (redeemedBy.userId.toString() === user._id.toString()) {
            return { user, plan, subscription: redeemedBy, business: null, alreadyApplied: true, previousEntitledPlan: null };
        }
        throw new ApiError(400, 'This payment has already been used to activate a subscription');
    }

    // ── Extend, never replace ─────────────────────────────────────────────────
    // Renewing early used to reset endDate to now + 1 month, deleting the days
    // the user had already paid for.
    const now = new Date();
    const stillRunningSamePlan =
        subscription &&
        subscription.plan === plan &&
        subscription.status === 'active' &&
        subscription.endDate > now;

    // create-order refuses to sell on top of a Play plan that will renew, but the
    // money may already be on its way (an order opened before the Play purchase,
    // or a stale tab). We still honour a payment we have taken. persistActivation
    // then retires the Play token, so the row stops listening to it, and Play —
    // which we cannot cancel from here — keeps billing until the user cancels it.
    // Say so loudly: that is a user paying twice and it needs a human to look.
    if (isRenewingPlaySubscription(subscription, now)) {
        console.warn(
            `⚠️ Cashfree payment ${cfPaymentId} activated over a renewing Google Play plan for user ${user._id}; ` +
            'Play will keep billing until the user cancels it in Google Play'
        );
    }

    const { subscription: saved, business, previousEntitledPlan } = await persistActivation({
        user,
        plan,
        startDate: stillRunningSamePlan ? (subscription.startDate || now) : now,
        endDate: addOneMonth(stillRunningSamePlan ? subscription.endDate : now),
        paymentId: cfPaymentId,
        source: 'cashfree',
        // A website payment buys one month and has no recurring mandate, so it
        // must not claim to auto-renew (that would be shown to the user).
        autoRenew: false
    });

    return { user, plan, subscription: saved, business, alreadyApplied: false, previousEntitledPlan };
};

export const createSubscriptionOrder = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    const validPaidPlans = ['small_business', 'corporate'];
    if (!plan || !validPaidPlans.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${validPaidPlans.join(', ')}`);
    }

    // A plan the owner is holding back (PLANS_COMING_SOON) cannot be bought, even
    // by an older client that still shows a Subscribe button. Verification of an
    // order that was already paid is deliberately NOT blocked.
    if (isPlanComingSoon(plan)) {
        // 409, not 403: a 403 from create-order means "finish your business profile"
        // to both clients, which is not what this is.
        throw new ApiError(409, `The ${SUBSCRIPTION_PLANS[plan].name} plan is not open for purchase yet.`);
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    if (!user.isBusinessProfile) {
        throw new ApiError(403, 'Only business accounts can purchase a subscription. Please create a business profile first.');
    }

    const Business = (await import('../../models/business.models.js')).default;
    const businessProfile = await Business.findOne({ userId });
    if (!businessProfile) {
        throw new ApiError(403, 'Business profile not found. Please complete your business profile setup before subscribing.');
    }

    const planDetails = SUBSCRIPTION_PLANS[plan];
    if (!planDetails) throw new ApiError(400, 'Invalid subscription plan');

    // ── Is Google Play already billing this user? ─────────────────────────────
    // A Play plan that renews keeps charging on its own. Selling a website month
    // on top of it would take the row over (activation overwrites it), Play would
    // keep billing a plan we no longer listen to, and its next renewal would
    // flip the plan back. So the website cannot change such a plan at all: it is
    // changed in the app (Upgrade / Downgrade), or renewal is cancelled in Play
    // first. A Play plan the user has already cancelled does not renew, so it is
    // not in the way and the purchase goes through.
    //
    // Our copy of "renews" is only as fresh as the last notification, and a user
    // who cancelled in Play a moment ago and came straight here would be told to
    // cancel what they just cancelled. So a row that looks like it renews is
    // checked with Play before the order is refused (playRowStillRenews). That
    // also covers a plan in Play's grace period, which is past its endDate here
    // but is still being retried by Play.
    //
    // 409, not 403: a 403 from create-order means "finish your business profile"
    // to both clients, and a 401 would sign the user out.
    const currentSubscription = await Subscription.findOne({ userId });
    if (isPossiblyBillingPlaySubscription(currentSubscription) && await playRowStillRenews(currentSubscription)) {
        throw new ApiError(
            409,
            'Your plan is billed through Google Play and renews automatically. Change it in the Android app, or cancel renewal in Google Play first.'
        );
    }

    const cashfreeOrderId = generateCashfreeOrderId();
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://findernate.com';
    const BACKEND_URL = process.env.BACKEND_URL || 'https://api.findernate.com';

    try {
        const cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        planDetails.price,
            customerId:    userId.toString(),
            customerName:  user.fullName || user.username || 'Customer',
            customerEmail: user.email || 'noreply@findernate.com',
            customerPhone: user.phoneNumber || '9999999999',
            orderNote:     `FinderNate ${planDetails.name} Subscription`,
            returnUrl:     `${FRONTEND_URL}/subscription/success?txnId=${cashfreeOrderId}&plan=${plan}`,
            notifyUrl:     `${BACKEND_URL}/api/v1/subscription/webhook`,
            expiryMinutes: 20
        });

        const paymentSessionId = cfOrder?.payment_session_id;
        if (!paymentSessionId) {
            throw new Error('Failed to get payment session from Cashfree');
        }

        const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);
        const cashfreeMode = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';

        PaymentLogger.logPaymentInitiated(userId.toString(), cashfreeOrderId, plan, planDetails.price);
        MetricsCollector.recordPaymentAttempt();

        res.status(200).json(
            new ApiResponse(200, {
                cashfreeOrderId,
                checkoutUrl,
                paymentSessionId,
                cashfreeMode,
                plan,
                planName: planDetails.name,
                planPrice: planDetails.price
            }, 'Cashfree payment initiated for subscription')
        );
    } catch (error) {
        console.error('❌ Cashfree subscription order creation failed:', error);
        ErrorLogger.logPaymentGatewayError(userId.toString(), null, error);
        throw new ApiError(500, `Payment gateway error: ${error.message}`);
    }
});

export const verifySubscriptionPayment = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { cashfreeOrderId, plan } = req.body;

    if (!cashfreeOrderId || !plan) {
        throw new ApiError(400, 'Missing required fields: cashfreeOrderId and plan');
    }

    const validPaidPlans = ['small_business', 'corporate'];
    if (!validPaidPlans.includes(plan)) {
        throw new ApiError(400, 'Invalid subscription plan');
    }

    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, 'Failed to verify payment status with Cashfree');
    }

    const isSuccess = cfOrder?.order_status === 'PAID';

    let cfPaymentId = cashfreeOrderId;
    if (isSuccess) {
        try {
            const payments = await getCashfreePayments(cashfreeOrderId);
            const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
            if (paid?.cf_payment_id) cfPaymentId = paid.cf_payment_id.toString();
        } catch { /* non-critical */ }
    }

    PaymentLogger.logPaymentVerification(userId.toString(), cfPaymentId, cashfreeOrderId, isSuccess);

    if (!isSuccess) {
        MetricsCollector.recordPaymentFailure();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    // All of the real checks — amount paid, plan bought, who paid, replay —
    // live in activateSubscriptionForOrder and run against the Cashfree order,
    // not the request body.
    const { plan: activatedPlan, subscription, business, alreadyApplied, previousEntitledPlan } =
        await activateSubscriptionForOrder({
            cfOrder,
            cfPaymentId,
            expectedUserId: userId,
            expectedPlan: plan
        });

    const businessDoc = business || await (await import('../../models/business.models.js')).default.findOne({ userId });

    const hasCallingAccess = ['small_business', 'corporate'].includes(activatedPlan);

    PaymentLogger.logPaymentSuccess(userId.toString(), cfPaymentId, cashfreeOrderId, activatedPlan, SUBSCRIPTION_PLANS[activatedPlan].price);
    SubscriptionLogger.logSubscriptionCreated(userId.toString(), activatedPlan, subscription.startDate, subscription.endDate);
    MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[activatedPlan].price, activatedPlan);

    res.status(200).json(
        new ApiResponse(200, {
            subscription: toPublicSubscription(subscription),
            business: { plan: businessDoc?.plan, subscriptionStatus: businessDoc?.subscriptionStatus },
            tier: activatedPlan,
            features: {
                calling: {
                    hasAccess: hasCallingAccess,
                    audioCall: hasCallingAccess,
                    videoCall: hasCallingAccess,
                    unlimited: hasCallingAccess
                }
            },
            message: planChangeMessage({
                planName: SUBSCRIPTION_PLANS[activatedPlan].name,
                plan: activatedPlan,
                previousPlan: previousEntitledPlan,
                alreadyApplied
            }),
            paymentId: cfPaymentId
        }, 'Subscription activated successfully')
    );
});

export const subscriptionWebhook = asyncHandler(async (req, res) => {
    // Signature is mandatory — it is the only authentication this route has.
    if (!requireCashfreeWebhookSignature(req, res, '[Cashfree subscription webhook]')) return;

    const payload       = req.body;
    const cfOrderId     = payload?.data?.order?.order_id;
    const orderStatus   = payload?.data?.order?.order_status;
    const cfPaymentId   = payload?.data?.payment?.cf_payment_id?.toString();
    const paymentStatus = payload?.data?.payment?.payment_status;

    if (orderStatus !== 'PAID' || paymentStatus !== 'SUCCESS' || !cfOrderId) {
        return res.status(200).json({ success: true });
    }

    PaymentLogger.logPaymentSuccess('webhook', cfPaymentId || '', cfOrderId, 'subscription', payload?.data?.order?.order_amount || 0);

    // Activate server-side as well. Activation used to happen ONLY in the
    // client's verify call on the success page, so a user whose app was killed
    // during the UPI hop paid and got nothing, with no way to recover except a
    // support ticket. Redemption is keyed on the payment id, so this is
    // idempotent with verifySubscriptionPayment whichever arrives first.
    try {
        const cfOrder = await getCashfreeOrderStatus(cfOrderId);
        if (cfOrder?.order_status !== 'PAID') {
            return res.status(200).json({ success: true });
        }

        const { user, plan, subscription, alreadyApplied } = await activateSubscriptionForOrder({
            cfOrder,
            cfPaymentId: cfPaymentId || cfOrderId
        });

        if (!alreadyApplied) {
            SubscriptionLogger.logSubscriptionCreated(user._id.toString(), plan, subscription.startDate, subscription.endDate);
            MetricsCollector.recordPaymentSuccess(SUBSCRIPTION_PLANS[plan].price, plan);
        }
    } catch (activationError) {
        // Never 500 back at Cashfree — that just triggers redelivery of a
        // payload we have already logged. Surface it for reconciliation instead.
        ErrorLogger.logPaymentGatewayError('webhook', cfOrderId, activationError);
        console.error(`[Cashfree subscription webhook] Activation failed for order ${cfOrderId}:`, activationError?.message || activationError);
    }

    return res.status(200).json({ success: true });
});
