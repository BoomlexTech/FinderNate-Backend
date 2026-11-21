import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
} from "../config/cashfree.config.js";
import { requireCashfreeWebhookSignature } from "../utils/cashfreeWebhook.utils.js";
import { assertTransactionBelongsToOrder } from "../utils/paymentVerification.utils.js";
// Guest checkout is shared with the shareable-link flow (payments.controllers.js).
// ONE implementation of the validators, of account creation and of the
// auto-refund — see utils/guestCheckout.utils.js for why a second copy is not
// an option here.
import {
    assertCompleteShippingAddress,
    assertGuestBuyerDetails,
    assertGuestEmailUnclaimed,
    recordGuestConsent,
    GUEST_CONSENT_SOURCE,
    settleGuestOrder,
    describeGuestAccount,
} from "../utils/guestCheckout.utils.js";
import { isOnlineStoreListing } from "./onlineStoreProducts.controllers.js";
// The flow names both checkouts price against. Imported rather than written as
// a literal here: the string this endpoint stamps on a PaymentLink is the same
// string resolveLinkPricingFlow matches on, and a typo in one of two copies is
// a silently unpayable link.
import { PRICING_FLOW, resolveDeletedPostContentType } from "./payments.controllers.js";
// A store product can be deleted while somebody still has its page open. Every
// other order-creation path answers the shared deleted-content tombstone rather
// than a bare 404 the client cannot tell apart from a broken URL; this one is
// the last that did not. See the util for the shape and for why a write path
// answers 410.
import { sendDeletedTombstone } from "../utils/contentTombstone.utils.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Order from "../models/order.models.js";
import PaymentLink from "../models/paymentLink.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";
import { publicApiUrl } from "../utils/publicUrls.js";

const getFrontendUrl = () => process.env.FRONTEND_URL || 'https://findernate.com';
// Cashfree sends its payment confirmations (notify_url) here, so a BACKEND_URL
// pointing at the host that does not exist must not be used (publicUrls.js).
const getBackendUrl  = () => publicApiUrl();

// How long a Cashfree checkout session stays payable.
const CF_SESSION_MINUTES = 20;
// A pending order is only considered abandoned well after its session died, so
// a payment still in flight is never retired out from under the buyer.
const PENDING_ABANDONED_MINUTES = CF_SESSION_MINUTES * 3;

const generateOrderNumber = () => {
    const ts     = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CF-${ts}-${random}`;
};

const generateLinkId = () =>
    `fnpay_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;

// Shapes the slice of a settled order the two verify responses return.
const publicOrderView = (order) => ({
    _id:            order._id,
    orderNumber:    order.orderNumber,
    orderStatus:    order.orderStatus,
    paymentStatus:  order.paymentStatus,
    amount:         order.amount,
    productDetails: order.productDetails
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/store/create-order
//
// Body: { postId, shippingAddress, buyerDetails? }
//   Amount is derived from the Post document — never trusted from the client.
//   shippingAddress: { fullName, phoneNumber, addressLine1, addressLine2?,
//                      city, state, postalCode, country? }
//   buyerDetails (guest only, ALL REQUIRED):
//       { fullName, email, phoneNumber, ageAttested: true, acceptedTerms: true }
//
// Returns: { checkoutUrl, paymentSessionId, cashfreeMode, cashfreeOrderId,
//            orderId, orderNumber, amount }
// ─────────────────────────────────────────────────────────────────────────────
export const createOnlineStoreOrder = asyncHandler(async (req, res) => {
    const { postId, shippingAddress, buyerDetails } = req.body;
    const buyerId = req.user?._id;

    if (!postId) {
        throw new ApiError(400, "postId is required");
    }

    assertCompleteShippingAddress(shippingAddress);

    // Guests only: a signed-in buyer already attested and accepted at signup.
    // Shape/consent validation only — it touches no database and so leaks
    // nothing about which addresses exist. The existing-email HARD STOP runs
    // further down, once a real product at a real price has been resolved.
    if (!buyerId) {
        assertGuestBuyerDetails(buyerDetails);
    }

    // ── Load post and seller ───────────────────────────────────────────────────
    const post = await Post.findById(postId);
    if (!post) {
        // 410 with the tombstone, not a bare 404: this call CREATES an order, so
        // it genuinely cannot be performed, and the store page has to be able to
        // say the product was taken down rather than showing a generic failure.
        // No order can be created past this point either way.
        //
        // The post is gone, so the noun is read back off the payment links minted
        // from it; the store only lists products, so that is the fallback when no
        // link recorded one.
        return sendDeletedTombstone(res, {
            contentType: (await resolveDeletedPostContentType(postId)) || 'product',
            contentId: postId,
            status: 410,
        });
    }

    // ── It must actually be something the online store sells ──────────────────
    // This route is PUBLIC and unauthenticated, and a few lines below it mints a
    // PaymentLink stamped pricingFlow:'online_store'. That stamp is what makes
    // the shareable pay endpoint (/post/:postId/pay/:amount) accept the STORE
    // total — shipping waived at ≥ ₹499 — for that post, permanently. Without
    // this gate one free anonymous request against any post on the platform
    // handed it shipping-waived pricing on the public pay URL forever, which is
    // a standing revenue leak on every item priced ≥ ₹499 that charges for
    // shipping.
    //
    // Inside the store's own catalogue there is nothing to leak: the store
    // total IS what the store charges for those products, which is exactly the
    // invariant resolvePricingFlowForLink assumes ("a product the store itself
    // sells at that price"). Same three conditions the store listing filters
    // on, from the same constant, so the catalogue and the checkout cannot
    // disagree. The store page is the only thing that links here, so no
    // legitimate purchase is affected.
    if (!isOnlineStoreListing(post)) {
        throw new ApiError(400, "This item is not sold through the online store");
    }

    const seller = await User.findById(post.userId);
    if (!seller) throw new ApiError(404, "Seller not found");

    // ── Derive price from the Post — client never supplies the amount ──────────
    let basePrice      = 0;
    let shippingCharge = 0;
    let gstPercent     = 0;
    let productDetails = {
        name:   post.caption || "Product",
        description: post.description || "",
        price:  0,
        images: post.media?.map(m => m.url || m.thumbnailUrl).filter(Boolean) || []
    };

    if (post.customization?.product) {
        const p    = post.customization.product;
        basePrice      = Number(p.price)           || 0;
        shippingCharge = Number(p.shippingCharges) || 0;
        gstPercent     = Number(p.gstPercent)      || 0;
        productDetails = {
            name:        p.name        || productDetails.name,
            description: p.description || productDetails.description,
            price:       basePrice,
            images:      p.images?.length ? p.images : productDetails.images,
            category:    p.category
        };
    } else if (post.customization?.service) {
        const s    = post.customization.service;
        basePrice      = Number(s.price)           || 0;
        shippingCharge = Number(s.shippingCharges) || 0;
        gstPercent     = Number(s.gstPercent)      || 0;
        productDetails = {
            name:        s.name        || productDetails.name,
            description: s.description || productDetails.description,
            price:       basePrice,
            images:      productDetails.images,
            category:    s.category
        };
    }

    // Nothing on the server ever checked availability, so a sold-out product
    // could be paid for in full: the buyer is charged, an order is created, and
    // the seller has nothing to ship. The listing page disables its own Buy
    // button when inStock is false, but that is a client-side courtesy and the
    // create-order route is reachable directly. Checked here, against the Post
    // the price was just derived from, so the two can never disagree.
    // `availability` is the seller-facing free-text field; inStock is the flag.
    if (post.customization?.product?.inStock === false) {
        throw new ApiError(400, "This product is out of stock");
    }

    if (basePrice <= 0) {
        throw new ApiError(400, "This product does not have a valid price set");
    }

    const gstAmount        = parseFloat(((basePrice * gstPercent) / 100).toFixed(2));
    const effectiveShipping = basePrice >= 499 ? 0 : shippingCharge; // free shipping on orders ≥ ₹499
    const numericAmount    = parseFloat((basePrice + effectiveShipping + gstAmount).toFixed(2)); // server-authoritative total

    // ── Existing-email HARD STOP ─────────────────────────────────────────────
    // No order is created, nothing is attached, no token is issued. The website
    // shows the message and the buyer signs in and comes back.
    //
    // The shareable flow has always done this; the store did not, so a guest
    // whose address already had an account PAID first and only found out at
    // settlement, when the order could not be linked to a buyer and had to be
    // auto-refunded. Stopping before the money moves is strictly better for the
    // same outcome.
    //
    // DELIBERATELY AFTER THE PRODUCT AND PRICE RESOLUTION, for the same reason
    // as in payments.controllers.js: the 409 is an account-existence oracle, so
    // a probe must cost a real store product at its real price — which is what
    // makes the per-IP checkout limiter on this route meaningful.
    //
    // The returned address is NORMALISED (trimmed, lowercased) and that is what
    // gets stored: every later lookup goes through Mongoose, which lowercases
    // its filters, so a mixed-case "Foo@Gmail.com" written verbatim would be
    // invisible to the refund and notification paths that have to reach this
    // buyer.
    let guestEmail = null;
    if (!buyerId) {
        guestEmail = await assertGuestEmailUnclaimed(buyerDetails.email);
    }

    // ── Retire abandoned sessions (NEVER delete an in-flight one) ──────────────
    // A buyer can buy the same product multiple times (separate orders), and a
    // 'pending' order is not an abandoned one: its Cashfree session stays live
    // for CF_SESSION_MINUTES while the buyer is off in their UPI app. Deleting
    // it meant the webhook for a payment already in progress found no order and
    // silently dropped a real payment. So we only mark orders whose session has
    // provably expired as 'failed', and always create a fresh distinct order.
    if (buyerId) {
        await Order.updateMany(
            {
                postId,
                buyerId,
                paymentStatus: 'pending',
                createdAt: { $lt: new Date(Date.now() - PENDING_ABANDONED_MINUTES * 60 * 1000) }
            },
            { $set: { paymentStatus: 'failed', orderStatus: 'cancelled' } }
        );
    }

    // ── Find or create a shared PaymentLink for this product ──────────────────
    let paymentLink = await PaymentLink.findOne({
        postId,
        amount: numericAmount,
        status: 'active',
        isShareableLink: true
    });

    if (!paymentLink) {
        const linkId      = generateLinkId();
        const frontendUrl = getFrontendUrl();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId: seller._id,
            postId,
            // What this link pointed at, recorded while the post is still here —
            // it is what names the thing in the tombstone after a deletion.
            // isOnlineStoreListing above has already established it is a product.
            contentType: post.contentType || 'product',
            productDetails,
            amount: numericAmount,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${numericAmount}`,
            shortUrl:   `${frontendUrl}/p/${linkId}`,
            isShareableLink: true,
            // The URL above carries the STORE total (shipping waived at ≥ ₹499),
            // which is not the total the shareable pay endpoint charges. Record
            // which flow minted it so opening that URL later resolves back to
            // this pricing instead of being rejected as a price mismatch — see
            // resolvePricingFlowForLink in payments.controllers.js.
            //
            // Only reached for a genuine store listing (checked above), so the
            // total this stamp unlocks on the pay URL is a total the store
            // really charges for this product.
            pricingFlow: PRICING_FLOW.ONLINE_STORE
        });
    }

    // ── Create order document ──────────────────────────────────────────────────
    const order = await Order.create({
        orderNumber:     generateOrderNumber(),
        buyerId:         buyerId || null,
        // Only the three fields the schema holds, with the NORMALISED email —
        // never the raw client object, which also carried the consent flags and
        // whatever else was in the request body.
        buyerDetails:    !buyerId ? {
            fullName:    buyerDetails.fullName,
            email:       guestEmail,
            phoneNumber: buyerDetails.phoneNumber
        } : undefined,
        sellerId:        seller._id,
        postId,
        paymentLinkId:   paymentLink._id,
        productDetails,
        amount:          numericAmount,
        shippingCharges: effectiveShipping,
        gstAmount,
        platformFee:     0,
        sellerAmount:    numericAmount,
        shippingAddress,
        orderStatus:     'payment_pending',
        paymentStatus:   'pending',
        isShareableOrder: true
    });

    if (!buyerId) {
        // LEGAL EVIDENCE for the 13+ attestation and the terms acceptance the
        // guest just ticked. Same helper as the shareable flow, so the record
        // has one shape and backfillGuestBuyer reads it the same way whichever
        // checkout wrote it.
        await recordGuestConsent(order._id, buyerDetails, req, GUEST_CONSENT_SOURCE.ONLINE_STORE);
    }

    // ── Create Cashfree payment order ──────────────────────────────────────────
    const cashfreeOrderId = generateCashfreeOrderId();
    const frontendUrl     = getFrontendUrl();
    const backendUrl      = getBackendUrl();

    const customerName  = shippingAddress.fullName;
    const customerPhone = shippingAddress.phoneNumber;
    const customerEmail = guestEmail || req.user?.email || 'noreply@findernate.com';
    const customerId    = buyerId ? buyerId.toString() : `guest_${order._id}`;

    let cfOrder;
    try {
        cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        numericAmount,
            customerId,
            customerName,
            customerEmail,
            customerPhone,
            orderNote:     `Payment for ${productDetails.name}`,
            returnUrl:     `${frontendUrl}/payment/success?txnId=${cashfreeOrderId}&orderId=${order._id}&source=store`,
            notifyUrl:     `${backendUrl}/api/v1/payments/cashfree/webhook`,
            expiryMinutes: CF_SESSION_MINUTES
        });
    } catch (cfError) {
        await Order.findByIdAndDelete(order._id);
        const msg =
            cfError?.response?.data?.message ||
            cfError?.message ||
            "Failed to initiate payment with Cashfree";
        throw new ApiError(400, msg);
    }

    const paymentSessionId = cfOrder?.payment_session_id;
    if (!paymentSessionId) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment session from Cashfree");
    }

    order.cashfreeOrderId = cashfreeOrderId;
    await order.save();

    const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);

    return res.status(200).json(
        new ApiResponse(200, {
            checkoutUrl,
            paymentSessionId,
            cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
            cashfreeOrderId,
            orderId:     order._id,
            orderNumber: order.orderNumber,
            amount:      numericAmount,  // server-resolved; frontend can display this
            // Server is the single source of truth for the tax/shipping split.
            // The store page used to recompute this from query params with a
            // different GST default and quoted a total we never charged.
            priceBreakdown: {
                basePrice,
                shippingCharges: effectiveShipping,
                gstPercent,
                gstAmount,
                totalPrice: numericAmount,
                currency: 'INR'
            }
        }, "Payment session created")
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/store/verify
// Public — no auth. Verifies a Cashfree payment after the buyer returns.
// Atomic: safe to call concurrently with the S2S webhook.
//
// Body: { txnId, orderId }  (txnId = cashfreeOrderId from the return URL)
// ─────────────────────────────────────────────────────────────────────────────
export const verifyOnlineStorePayment = asyncHandler(async (req, res) => {
    const { txnId, cashfreeOrderId: cfIdBody, orderId } = req.body;
    const cashfreeOrderId = cfIdBody || txnId;

    if (!cashfreeOrderId || !orderId) {
        throw new ApiError(400, "txnId (cashfreeOrderId) and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) throw new ApiError(404, "Order not found");

    // Idempotency — already confirmed
    if (['paid', 'held', 'released'].includes(order.paymentStatus)) {
        // The payment is confirmed, so a guest order still missing its buyer
        // gets one here — this call is what heals the case where the webhook
        // marked the order paid but the account creation did not run or failed.
        // No-op once buyerId is set. The escrow credit is already in place on
        // this branch (the execution that banked the payment wrote it), so an
        // auto-refund can go straight out.
        const settled = await settleGuestOrder(order);
        // Read the account state back rather than assuming this call created it:
        // on the common webhook-races-verify ordering the other execution did,
        // and the buyer still has to be told.
        const guest = await describeGuestAccount(order);
        // Re-read after an auto-refund: `order` was loaded before it ran.
        const shown = settled.orphaned ? (await Order.findById(order._id)) || order : order;
        return res.status(200).json(
            new ApiResponse(200, {
                order: publicOrderView(shown),
                ...guest
            }, "Payment already verified")
        );
    }

    // Check Cashfree
    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, "Failed to fetch order status from Cashfree");
    }

    // Bind the transaction to THIS order before believing anything it says.
    // This route is public and the transaction id comes from the request body, so
    // without this a caller could quote their own real ₹1 PAID transaction against
    // any other pending order and settle it for free. Same rule as the escrow
    // verify path — deliberately the same helper, not a second copy that can drift.
    assertTransactionBelongsToOrder(cfOrder, order);

    if (cfOrder?.order_status !== 'PAID') {
        order.paymentStatus = 'failed';
        order.orderStatus   = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    // Fetch Cashfree payment ID (non-critical)
    let cfPaymentId = null;
    try {
        const payments = await getCashfreePayments(cashfreeOrderId);
        const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
        cfPaymentId = paid?.cf_payment_id?.toString() || null;
    } catch { /* non-critical */ }

    // Atomic update — races safely with the webhook.
    // cashfreeOrderId is deliberately NOT written here: it is set at order creation
    // and is the value just validated against, so rewriting it from a request body
    // would let a caller re-aim the order at a transaction of their choosing.
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId,
            paymentStatus: 'paid',
            orderStatus:   'payment_received'
        },
        { new: true }
    );

    if (!updated) {
        // Webhook already processed it — including the escrow credit, so a
        // refund can go out immediately if the back-fill finds a collision.
        const refreshed = await Order.findById(order._id);
        const settled = await settleGuestOrder(refreshed);
        const guest = await describeGuestAccount(refreshed);
        // Re-read after an auto-refund: `refreshed` predates it.
        const shown = settled.orphaned ? (await Order.findById(refreshed._id)) || refreshed : refreshed;
        return res.status(200).json(
            new ApiResponse(200, {
                order: publicOrderView(shown),
                ...guest
            }, "Payment verified")
        );
    }

    await PaymentLink.findByIdAndUpdate(
        order.paymentLinkId,
        { status: 'paid', paidAt: new Date() }
    );

    // Payment is CONFIRMED — create the guest's account now (never at order
    // creation), attach it, send the "set your password" claim, and auto-refund
    // the rare order that cannot be given a buyer.
    //
    // THIS IS THE FIX FOR ORDERS THAT USED TO SETTLE OWNERLESS. The store flow
    // creates guest orders with buyerId:null and used to stop right after the
    // escrow credit: no account, no marker, nothing flagged. The buyer ended up
    // with no order history, no way to confirm delivery, no way to dispute and
    // no invoice, while their money sat in escrow indefinitely.
    //
    // settleGuestOrder owns the ORDERING, which is not interchangeable: the
    // back-fill runs BEFORE the escrow write (the ledger row copies
    // order.buyerId at write time, so crediting first stamps the row with null)
    // and the refund runs AFTER it (it unwinds the entry the credit just made).
    // Identical sequence to the shareable flow, from the same module — the only
    // difference is that this flow records a credit where that one records a
    // hold. Idempotent in every ordering: account creation and the claim
    // message are both gated on winning one atomic conditional update.
    const settled = await settleGuestOrder(updated, async () => {
        // Without this row admin can neither release nor refund the sale, so a
        // failure here must be visible in the logs — but it must not fail the
        // payment response either, and it must not stop the buyer getting an
        // account.
        try {
            const wallet = await EscrowWallet.getWallet();
            await wallet.creditPayment(updated, updated.amount, `Store payment for order ${updated.orderNumber}`);
        } catch (walletError) {
            console.error(`[Cashfree store verify] Failed to record escrow credit for order ${updated.orderNumber}:`, walletError);
        }
    });

    const guest = await describeGuestAccount(updated);

    // An auto-refund just moved this order to refunded/refunded, so the
    // in-memory snapshot taken before it is stale — report what the database
    // says, or the page tells the buyer their payment succeeded while the money
    // is on its way back.
    const shown = settled.orphaned ? (await Order.findById(updated._id)) || updated : updated;

    return res.status(200).json(
        new ApiResponse(200, {
            order: publicOrderView(shown),
            ...guest
        }, "Payment verified successfully")
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/cashfree/webhook
// Cashfree S2S webhook — no auth, called by Cashfree servers.
// ─────────────────────────────────────────────────────────────────────────────
export const cashfreeWebhook = asyncHandler(async (req, res) => {
    // Signature is mandatory — it is the only authentication this route has.
    if (!requireCashfreeWebhookSignature(req, res, '[Cashfree store webhook]')) return;

    const payload       = req.body;
    const cfOrderId     = payload?.data?.order?.order_id;
    const orderStatus   = payload?.data?.order?.order_status;
    const cfPaymentId   = payload?.data?.payment?.cf_payment_id?.toString();
    const paymentStatus = payload?.data?.payment?.payment_status;

    if (orderStatus !== 'PAID' || paymentStatus !== 'SUCCESS' || !cfOrderId) {
        return res.status(200).json({ status: 'ok' });
    }

    const order = await Order.findOne({ cashfreeOrderId: cfOrderId });
    if (!order) {
        return res.status(200).json({ status: 'ok' });
    }

    if (order.paymentStatus !== 'pending') {
        // A repeat delivery of a webhook we have already banked. Still worth a
        // pass at the guest settlement: it is a no-op once buyerId is set, and
        // it is the retry for a first delivery whose account creation failed.
        // The escrow credit is already written on this branch, so a refund can
        // go out.
        await settleGuestOrder(order);
        return res.status(200).json({ status: 'ok' });
    }

    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId || null,
            paymentStatus: 'paid',
            orderStatus:   'payment_received'
        },
        { new: true }
    );

    if (updated) {
        await PaymentLink.findByIdAndUpdate(
            order.paymentLinkId,
            { status: 'paid', paidAt: new Date() }
        );
        // Confirmed payment — this is the other place a store order becomes
        // paid, and it may run before, after, or alongside the verify call. The
        // same pipeline runs here, and it is safe in every ordering: the
        // account is created at most once and the claim link sent at most once,
        // both gated on winning one atomic conditional update. Back-fill before
        // the escrow credit, auto-refund after it — see settleGuestOrder.
        await settleGuestOrder(updated, async () => {
            try {
                const wallet = await EscrowWallet.getWallet();
                await wallet.creditPayment(updated, updated.amount, `Store payment for order ${updated.orderNumber}`);
            } catch (walletError) {
                console.error(`[Cashfree store webhook] Failed to record escrow credit for order ${updated.orderNumber}:`, walletError);
            }
        });
    }

    return res.status(200).json({ status: 'ok' });
});
