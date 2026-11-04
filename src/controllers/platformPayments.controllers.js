import mongoose from 'mongoose';
import PlatformPurchase from '../models/platformPurchase.models.js';
import AdCampaign from '../models/adCampaign.models.js';
import PaidListing from '../models/paidListing.models.js';
import Business from '../models/business.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { withGst } from '../utils/phase4.rules.js';
import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
} from '../config/cashfree.config.js';
import { isGooglePlayConfigured, getProductPurchase, consumeProductPurchase } from '../config/googlePlay.config.js';
import { requireCashfreeWebhookSignature } from '../utils/cashfreeWebhook.utils.js';

/**
 * Payments to Findernate itself (Phase 4): ads (#27), the re-KYC fee (#74),
 * one-time listings (#80) and the plan for regular users (#77).
 *
 * Website: Cashfree. Android app: Google Play one-time products. iPhone: not
 * sold in the app (Apple In-App Purchase isn't integrated).
 *
 * Prices are admin settings; a feature whose price isn't set can't be bought.
 */

export const DEFAULT_PLAY_PRODUCTS = {
    re_kyc: 're_kyc_fee',
    listing_30: 'listing_30_days',
    listing_60: 'listing_60_days',
    plus: 'findernate_plus_30_days',
    ad: { 1: 'ad_1_day', 3: 'ad_3_days', 7: 'ad_7_days', 15: 'ad_15_days', 30: 'ad_30_days' },
};

export const playProducts = async () => ({ ...DEFAULT_PLAY_PRODUCTS, ...(await getSettingValue('PLAY_PRODUCT_IDS', {})) });

export const gstPercent = async () => Number(await getSettingValue('PLATFORM_GST_PERCENT', 18));

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** What a purchase of `kind` for `refId` costs, and the Play product for it. */
const quote = async (kind, refId, userId) => {
    const gstP = await gstPercent();
    const products = await playProducts();
    if (kind === 'ad') {
        const ad = await AdCampaign.findOne({ _id: refId, userId });
        if (!ad) throw new ApiError(404, 'Ad not found');
        if (!['draft', 'awaiting_payment'].includes(ad.status)) throw new ApiError(409, 'This ad is already paid for');
        return { amount: ad.amount, gstPct: ad.gstPercent, description: `Ad for ${ad.days} day${ad.days === 1 ? '' : 's'}`, productId: products.ad?.[ad.days] || null };
    }
    if (kind === 'listing') {
        const listing = await PaidListing.findOne({ _id: refId, userId });
        if (!listing) throw new ApiError(404, 'Listing not found');
        if (listing.status !== 'awaiting_payment') throw new ApiError(409, listing.status === 'flagged' ? 'This listing is being reviewed' : 'This listing is not waiting for payment');
        return { amount: listing.amount, gstPct: listing.gstPercent, description: `Product listing for ${listing.days} days`, productId: products[`listing_${listing.days}`] || null };
    }
    if (kind === 're_kyc') {
        const fee = num(await getSettingValue('RE_KYC_FEE', 100));
        if (!fee) throw new ApiError(409, 'Re-verification is not available yet');
        return { amount: fee, gstPct: gstP, description: 'Business re-verification', productId: products.re_kyc };
    }
    if (kind === 'plus') {
        const price = num(await getSettingValue('PLUS_PLAN_PRICE', null));
        if (!price) throw new ApiError(409, 'This plan is coming soon');
        return { amount: price, gstPct: gstP, description: 'Findernate Plus for 30 days', productId: products.plus };
    }
    throw new ApiError(400, 'Unknown purchase type');
};

// ─── Fulfilment ──────────────────────────────────────────────────────────────

const fulfil = async (purchase) => {
    // Claim it once, so a webhook and a verify call can't both run it.
    const claimed = await PlatformPurchase.findOneAndUpdate(
        { _id: purchase._id, status: 'paid', fulfilledAt: null },
        { $set: { fulfilledAt: new Date() } },
        { new: true }
    );
    if (!claimed) return;
    const now = new Date();
    if (purchase.kind === 'ad') {
        const ad = await AdCampaign.findById(purchase.refId);
        if (!ad) return;
        const start = ad.requestedStartAt && new Date(ad.requestedStartAt) > now ? new Date(ad.requestedStartAt) : now;
        ad.startAt = start;
        ad.endAt = new Date(start.getTime() + ad.days * 86400000);
        ad.status = start > now ? 'scheduled' : 'running';
        ad.paidAt = now;
        ad.purchaseId = purchase._id;
        await ad.save();
        await notifyActivity({ recipientId: ad.userId, type: 'ad', message: ad.status === 'running' ? 'Your ad is live.' : 'Your ad is paid and scheduled.', data: { adId: String(ad._id) } });
    } else if (purchase.kind === 'listing') {
        const listing = await PaidListing.findById(purchase.refId);
        if (!listing) return;
        listing.status = 'active';
        listing.startsAt = now;
        listing.endsAt = new Date(now.getTime() + listing.days * 86400000);
        listing.purchaseId = purchase._id;
        await listing.save();
        await notifyActivity({ recipientId: listing.userId, type: 'listing', message: `Your listing is live for ${listing.days} days.`, postId: listing.postId, data: { listingId: String(listing._id) } });
    } else if (purchase.kind === 're_kyc') {
        await Business.updateOne({ userId: purchase.userId }, {
            $set: { detailsLocked: false, 'detailsConfirmation.status': 'none', 'kyc.reKycPaidAt': now },
        });
        await notifyActivity({ recipientId: purchase.userId, type: 'kyc', message: 'Re-verification paid. You can now edit your business details and submit them again.' });
    } else if (purchase.kind === 'plus') {
        const user = await User.findById(purchase.userId).select('plusUntil');
        const from = user?.plusUntil && user.plusUntil > now ? user.plusUntil : now;
        await User.updateOne({ _id: purchase.userId }, { $set: { plusUntil: new Date(from.getTime() + 30 * 86400000), plusRemindersSent: [] } });
        await notifyActivity({ recipientId: purchase.userId, type: 'plan_expiry', message: 'Findernate Plus is active. Enjoy Findernate without ads.' });
    }
};

/** Marks a purchase paid and fulfils it. Exported for the reconcile job. */
export const markPaidAndFulfil = async (purchase, extra = {}) => {
    if (purchase.status !== 'paid') {
        await PlatformPurchase.updateOne({ _id: purchase._id, status: { $ne: 'paid' } }, {
            $set: { status: 'paid', paidAt: new Date(), invoiceNumber: `FN-${Date.now().toString(36).toUpperCase()}`, ...extra },
        });
        purchase.status = 'paid';
    }
    await fulfil(purchase);
};

// ─── Website: Cashfree ──────────────────────────────────────────────────────

/** POST /platform-payments/:kind/checkout  { refId? } */
export const createPlatformCheckout = asyncHandler(async (req, res) => {
    const { kind } = req.params;
    const refId = req.body?.refId && mongoose.Types.ObjectId.isValid(req.body.refId) ? req.body.refId : null;
    const userId = req.user._id;
    const q = await quote(kind, refId, userId);
    const price = withGst(q.amount, q.gstPct);

    const user = await User.findById(userId).select('fullName username email phoneNumber').lean();
    const orderId = generateCashfreeOrderId();
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://findernate.com';
    const BACKEND_URL = process.env.BACKEND_URL || 'https://apis.findernate.com';
    const cf = await createCashfreeOrder({
        orderId,
        amount: price.total,
        customerId: String(userId),
        customerName: user?.fullName || user?.username,
        customerEmail: user?.email,
        customerPhone: user?.phoneNumber,
        orderNote: `Findernate ${q.description}`,
        returnUrl: `${FRONTEND_URL}/payments/platform/return?orderId=${orderId}`,
        notifyUrl: `${BACKEND_URL}/api/v1/platform-payments/webhook`,
    });
    if (!cf?.payment_session_id) throw new ApiError(502, "Couldn't start the payment. Try again.");

    const purchase = await PlatformPurchase.create({
        userId, kind, refId, description: q.description,
        amount: price.amount, gstPercent: price.gstPercent, gst: price.gst, total: price.total,
        provider: 'cashfree', cashfreeOrderId: orderId,
    });
    if (kind === 'ad') await AdCampaign.updateOne({ _id: refId }, { $set: { status: 'awaiting_payment' } });

    return res.status(200).json(new ApiResponse(200, {
        purchaseId: purchase._id,
        cashfreeOrderId: orderId,
        paymentSessionId: cf.payment_session_id,
        checkoutUrl: buildCashfreeCheckoutUrl(cf.payment_session_id),
        cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
        amount: price.amount, gst: price.gst, total: price.total,
    }, 'Payment started'));
});

const settleCashfree = async (purchase) => {
    const order = await getCashfreeOrderStatus(purchase.cashfreeOrderId);
    if (order?.order_status !== 'PAID') return false;
    if (Math.abs(Number(order.order_amount) - purchase.total) > 0.01) {
        console.error(`[platform-pay] amount mismatch for ${purchase.cashfreeOrderId}`);
        return false;
    }
    let paymentId;
    try {
        const payments = await getCashfreePayments(purchase.cashfreeOrderId);
        paymentId = (payments || []).find((p) => p.payment_status === 'SUCCESS')?.cf_payment_id;
    } catch { /* optional */ }
    await markPaidAndFulfil(purchase, paymentId ? { cashfreePaymentId: String(paymentId) } : {});
    return true;
};

/** POST /platform-payments/verify  { cashfreeOrderId } */
export const verifyPlatformPayment = asyncHandler(async (req, res) => {
    const purchase = await PlatformPurchase.findOne({ cashfreeOrderId: String(req.body?.cashfreeOrderId || ''), userId: req.user._id });
    if (!purchase) throw new ApiError(404, 'Payment not found');
    const paid = purchase.status === 'paid' || await settleCashfree(purchase);
    return res.status(200).json(new ApiResponse(200, { paid, kind: purchase.kind, refId: purchase.refId }, paid ? 'Payment confirmed' : 'Payment not completed yet'));
});

/** POST /platform-payments/webhook (Cashfree S2S) */
export const platformPaymentWebhook = asyncHandler(async (req, res) => {
    if (!requireCashfreeWebhookSignature(req, res, '[platform-pay webhook]')) return;
    const orderId = req.body?.data?.order?.order_id;
    const purchase = orderId ? await PlatformPurchase.findOne({ cashfreeOrderId: orderId }) : null;
    if (purchase && purchase.status !== 'paid') await settleCashfree(purchase).catch(() => {});
    return res.status(200).json({ status: 'ok' });
});

/** For the reconcile job: settles Cashfree orders whose return/webhook was missed. */
export const reconcilePendingPlatformPayments = async () => {
    const since = new Date(Date.now() - 2 * 86400000);
    const pending = await PlatformPurchase.find({ provider: 'cashfree', status: 'created', createdAt: { $gte: since } }).limit(100);
    for (const p of pending) await settleCashfree(p).catch(() => {});
};

// ─── Android: Google Play ───────────────────────────────────────────────────

/** POST /platform-payments/:kind/play  { refId?, productId, purchaseToken } */
export const confirmPlayPurchase = asyncHandler(async (req, res) => {
    const { kind } = req.params;
    const { productId, purchaseToken } = req.body || {};
    const refId = req.body?.refId && mongoose.Types.ObjectId.isValid(req.body.refId) ? req.body.refId : null;
    if (!productId || !purchaseToken) throw new ApiError(400, 'productId and purchaseToken are required');
    if (!isGooglePlayConfigured()) throw new ApiError(503, 'Google Play purchases are not set up on the server');

    const existing = await PlatformPurchase.findOne({ playPurchaseToken: purchaseToken });
    if (existing) {
        if (String(existing.userId) !== String(req.user._id)) throw new ApiError(409, 'This purchase belongs to another account');
        if (existing.status === 'paid') await fulfil(existing);
        return res.status(200).json(new ApiResponse(200, { paid: existing.status === 'paid', refId: existing.refId }, 'Already recorded'));
    }

    const q = await quote(kind, refId, req.user._id);
    if (q.productId && q.productId !== productId) throw new ApiError(400, 'That product is not for this purchase');

    const play = await getProductPurchase(productId, purchaseToken);
    if (Number(play?.purchaseState) !== 0) throw new ApiError(402, 'The purchase is not complete');
    const owner = play?.obfuscatedExternalAccountId;
    if (owner && owner !== String(req.user._id)) throw new ApiError(409, 'This purchase belongs to another account');

    const price = withGst(q.amount, q.gstPct);
    const purchase = await PlatformPurchase.create({
        userId: req.user._id, kind, refId, description: q.description,
        amount: price.amount, gstPercent: price.gstPercent, gst: price.gst, total: price.total,
        provider: 'google_play', playProductId: productId, playPurchaseToken: purchaseToken, playOrderId: play?.orderId,
    });
    await markPaidAndFulfil(purchase);
    // Consumed so the user can buy the same product again later.
    await consumeProductPurchase(productId, purchaseToken);
    return res.status(200).json(new ApiResponse(200, { paid: true, refId }, 'Purchase confirmed'));
});

/** GET /platform-payments/config — prices and Play product ids for the clients. */
export const getPlatformPaymentConfig = asyncHandler(async (req, res) => {
    const [reKycFee, plusPrice, listing30, listing60, adDailyFee, gst, products] = await Promise.all([
        getSettingValue('RE_KYC_FEE', 100),
        getSettingValue('PLUS_PLAN_PRICE', null),
        getSettingValue('LISTING_FEE_30', null),
        getSettingValue('LISTING_FEE_60', null),
        getSettingValue('AD_DAILY_FEE', 100),
        gstPercent(),
        playProducts(),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        gstPercent: gst,
        reKycFee: num(reKycFee),
        plusPrice: num(plusPrice),
        listingFees: { 30: num(listing30), 60: num(listing60) },
        adDailyFee: num(adDailyFee),
        playProducts: products,
        playEnabled: isGooglePlayConfigured(),
        iosPurchases: false,
    }, 'OK'));
});

/** GET /platform-payments/mine — receipts. */
export const myPlatformPurchases = asyncHandler(async (req, res) => {
    const rows = await PlatformPurchase.find({ userId: req.user._id, status: { $in: ['paid', 'refunded'] } })
        .sort({ createdAt: -1 }).limit(100).lean();
    return res.status(200).json(new ApiResponse(200, { purchases: rows }, 'OK'));
});
