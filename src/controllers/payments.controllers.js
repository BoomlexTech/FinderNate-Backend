import {
    generateCashfreeOrderId,
    createCashfreeOrder,
    getCashfreeOrderStatus,
    getCashfreePayments,
    buildCashfreeCheckoutUrl,
} from "../config/cashfree.config.js";
import { requireCashfreeWebhookSignature } from "../utils/cashfreeWebhook.utils.js";
import { assertTransactionBelongsToOrder } from "../utils/paymentVerification.utils.js";
// Guest checkout is shared with the online-store checkout
// (cashfree.payment.controller.js) — one implementation of account creation and
// of the auto-refund, never two. See utils/guestCheckout.utils.js.
import {
    assertCompleteShippingAddress,
    assertGuestBuyerDetails,
    assertGuestEmailUnclaimed,
    recordGuestConsent,
    GUEST_CONSENT_SOURCE,
    settleGuestOrder,
    describeGuestAccount,
} from "../utils/guestCheckout.utils.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
// A payment link outlives the post it was minted from — the post row is deleted
// outright and nothing rewrites the links pointing at it. Every endpoint that
// resolves one therefore answers with an explicit tombstone instead of a 404 a
// buyer's browser cannot tell apart from a broken URL. See the util for the
// exact shape and for why reads answer 200 while order creation answers 410.
import { sendDeletedTombstone } from "../utils/contentTombstone.utils.js";
import Order from "../models/order.models.js";
import PaymentLink from "../models/paymentLink.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";
import Post from "../models/userPost.models.js";
import { User } from "../models/user.models.js";
import Chat from "../models/chat.models.js";
import Message from "../models/message.models.js";
import socketManager from "../config/socket.js";
import { publicApiUrl } from "../utils/publicUrls.js";

// Always use configured FRONTEND_URL for payment links (never use request origin)
const getFrontendUrl = () => {
    return process.env.FRONTEND_URL || 'https://findernate.com';
};

// Cashfree sends its payment confirmations (notify_url) here, so a BACKEND_URL
// pointing at the host that does not exist must not be used (publicUrls.js).
const getBackendUrl = () => publicApiUrl();

// Maps internal 'held' status to 'paid' for user-facing responses.
// Admin sees 'held' in DB so they can manually transfer funds.
const toUserPaymentStatus = (s) => s === 'held' ? 'paid' : s;

const generateOrderNumber = () => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `FN-${timestamp}-${random}`;
};

const generateLinkId = () => {
    return `fnpay_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;
};

// How long a Cashfree checkout session stays payable.
const CF_SESSION_MINUTES = 20;
// A 'pending' order is only abandoned well after its session died — until then
// the buyer may still be approving the payment in their UPI app.
const PENDING_ABANDONED_MINUTES = CF_SESSION_MINUTES * 3;

const round2 = (value) => parseFloat(Number(value).toFixed(2));

// ── Server-authoritative pricing ─────────────────────────────────────────────
// The amount charged for a post is ALWAYS derived from the post document. A
// price arriving in a request body or a URL segment (/post/:postId/pay/:amount)
// is only ever a display hint to cross-check — never the figure we bill.
const resolvePostPricing = (post) => {
    let basePrice       = 0;
    let shippingCharges = 0;
    let gstPercent      = 0;

    if (post.customization?.product) {
        const p = post.customization.product;
        basePrice       = Number(p.price)           || 0;
        shippingCharges = Number(p.shippingCharges) || 0;
        gstPercent      = Number(p.gstPercent)      || 0;
    } else if (post.customization?.service) {
        const s = post.customization.service;
        basePrice       = Number(s.price) || 0;
        // additionalCharges is the primary extra-fee field for services
        shippingCharges = (Number(s.additionalCharges) || 0) + (Number(s.shippingCharges) || 0);
        gstPercent      = Number(s.gstPercent) || 0;
    }

    const gstAmount  = round2((basePrice * gstPercent) / 100);
    const totalPrice = round2(basePrice + shippingCharges + gstAmount);
    // The online-store checkout waives shipping at ≥ ₹499, so a link minted by
    // that flow carries a different — but equally server-computed — total.
    const storeTotalPrice = round2(basePrice + (basePrice >= 499 ? 0 : shippingCharges) + gstAmount);

    return { basePrice, shippingCharges, gstPercent, gstAmount, totalPrice, storeTotalPrice };
};

// ── What kind of thing is this post, for the tombstone wording? ──────────────
// A deleted post takes its own contentType with it, so anything that has to
// name it afterwards must have recorded it while the post was still there. Every
// PaymentLink mint below stamps this, and the read endpoints back-fill links
// minted before the field existed. Prefers the customization block over
// Post.contentType: a listing carrying a product/service block is that thing,
// whatever the post was originally composed as.
const postContentType = (post) => {
    if (!post) return null;
    if (post.customization?.product) return 'product';
    if (post.customization?.service) return 'service';
    return post.contentType || null;
};

// Best effort at the type of a post that is ALREADY GONE: the links minted from
// it recorded one. Used only on the deleted branches, so it costs nothing on the
// happy path, and a null simply degrades the tombstone to "item" — exactly what
// those branches said before.
//
// Exported because the online-store checkout (cashfree.payment.controller.js)
// needs the same answer, and a second copy of it would be a second thing to keep
// in step with the field name.
export const resolveDeletedPostContentType = async (postId) => {
    if (!postId) return null;
    try {
        const link = await PaymentLink.findOne({ postId, contentType: { $exists: true, $ne: null } })
            .select('contentType')
            .sort({ createdAt: -1 });
        return link?.contentType || null;
    } catch {
        // Wording only — never fail a checkout over it.
        return null;
    }
};

// Records the type on a link that predates the field, while the post is still
// alive to be asked. One write per link, ever; failure is silent because this is
// cosmetic and the caller is a read endpoint on a money path.
const backfillLinkContentType = async (paymentLink, post) => {
    if (!paymentLink || paymentLink.contentType) return;
    const type = postContentType(post);
    if (!type) return;
    try {
        await PaymentLink.updateOne({ _id: paymentLink._id }, { $set: { contentType: type } });
        paymentLink.contentType = type;
    } catch { /* cosmetic */ }
};

// ── A seller pricing their OWN listing ───────────────────────────────────────
// A discount is the seller's to give, but a typo is not: ₹9,900 typed where
// ₹99 was meant would otherwise mint a link that charges 100x. The floor is the
// gateway's own minimum, and the ceiling is generous — the point is to catch a
// slipped digit, not to police what a seller may charge for their own item.
//
// The bound is re-applied at PAY time against the post as it stands then, so a
// link cannot become absurd later by the seller lowering the listed price.
const MIN_CHARGEABLE_AMOUNT = 1;          // Cashfree rejects anything below ₹1
// Ceiling for the ONE remaining case where a shareable link carries a figure
// that did not come from the listing: a post with no product/service price
// block at all, where there is no list total to mint at. Everywhere else the
// link is minted at the post's own total, so no caller-supplied price survives.
// "No reference price" must still not mean "no limit" — a slipped digit here
// mints a link that charges 100x.
const UNPRICED_POST_AMOUNT_CEILING = 500000; // ₹5,00,000
const assertLinkAmountAllowed = (amount) => {
    if (!Number.isFinite(amount) || amount < MIN_CHARGEABLE_AMOUNT) {
        throw new ApiError(400, `Amount must be at least ₹${MIN_CHARGEABLE_AMOUNT}`);
    }
    if (amount > UNPRICED_POST_AMOUNT_CEILING) {
        throw new ApiError(400,
            `Amount cannot be more than ₹${UNPRICED_POST_AMOUNT_CEILING}. This listing has no price set, so the amount on its link is capped.`
        );
    }
};

// ── Which total is legitimate depends on WHICH FLOW is asking ────────────────
// Two flows mint links for the same post and they charge differently: the
// online store waives shipping at ≥ ₹499, the shareable payment link never
// does. Accepting either total everywhere meant a shareable-link buyer could
// simply submit the store total and skip the shipping charge — both figures are
// server-computed, so it was never a payment bypass, but it was a standing
// revenue leak for every product priced at ₹499 or more.
//
// So the caller now says which flow it is, and the amount is validated against
// THAT flow's own total:
//   PRICING_FLOW.SHAREABLE_LINK — createShareableCashfreeOrder. Charges the full
//       total including shipping. This is the money path for this file.
//   PRICING_FLOW.ONLINE_STORE   — the store's own total (shipping waived at
//       ≥ ₹499). The store checkout itself lives in
//       cashfree.payment.controller.js and computes this figure directly; the
//       constant exists so anything in this file that has to speak for that
//       flow validates against the right number.
//   PRICING_FLOW.ANY_LINK       — READ-ONLY quotes for a stored link. A
//       PaymentLink can have been minted by either flow (both write
//       /post/:postId/pay/:amount as their paymentUrl), so a display endpoint
//       must recognise both totals or it would 400 on a perfectly valid store
//       link. Never use this to decide what to charge.
export const PRICING_FLOW = {
    SHAREABLE_LINK: 'shareable_link',
    ONLINE_STORE:   'online_store',
    ANY_LINK:       'any_link',
};

// ── Which flow does a STORED link speak for? ─────────────────────────────────
// A /post/:postId/pay/:amount URL does not say who minted it, and the two flows
// mint it at different figures. Hard-coding SHAREABLE_LINK on the pay path made
// every store-minted link permanently unpayable: the store writes its own
// (shipping-waived) total into the URL, the pay endpoint accepted only the
// non-waived one, and "please reload" reloaded to the very same number.
//
// So the flow is resolved from the PaymentLink the URL belongs to instead of
// being assumed. This is NOT "accept both totals everywhere" — the store total
// is accepted only where a link minted by the store actually exists at exactly
// that figure, which is precisely a product the store itself sells at that
// price. A shareable link with no store counterpart still accepts nothing but
// the full total, so the revenue leak the previous pass closed stays closed.
const resolveLinkPricingFlow = (link, pricing) => {
    if (link?.pricingFlow === PRICING_FLOW.ONLINE_STORE)   return PRICING_FLOW.ONLINE_STORE;
    if (link?.pricingFlow === PRICING_FLOW.SHAREABLE_LINK) return PRICING_FLOW.SHAREABLE_LINK;

    // LEGACY ROWS ONLY. The seller-set price feature has been removed, so nothing
    // writes `sellerSetAmount` any more — but rows minted while it existed still
    // carry it, and for those the figure came from the seller rather than from
    // either checkout. It is not evidence of which flow minted the link and must
    // never be read as one: a seller link that happens to sit at the store's
    // shipping-waived total would otherwise be inferred as a store mint and hand
    // that waiver to the public pay URL for a post the store does not sell.
    // Read off the raw document because the field is no longer in the schema.
    if (link?.get?.('sellerSetAmount', null, { strict: false })) {
        return PRICING_FLOW.SHAREABLE_LINK;
    }

    // Minted before pricingFlow was recorded: infer from the figure it carries.
    // Only conclusive when the two totals differ — when they are equal (no
    // shipping charge, or a base price under the ₹499 waiver threshold) both
    // flows accept the same number and the answer does not matter.
    const amount = Number(link?.amount);
    if (
        Number.isFinite(amount) &&
        Math.abs(amount - pricing.storeTotalPrice) < 0.01 &&
        Math.abs(amount - pricing.totalPrice) >= 0.01
    ) {
        return PRICING_FLOW.ONLINE_STORE;
    }

    return PRICING_FLOW.SHAREABLE_LINK;
};

// Looks up the link a /post/:postId/pay/:amount URL refers to, purely to answer
// "which flow minted this figure".
//
// DELIBERATELY IGNORES link.status. A link goes to 'paid' the moment somebody
// completes a purchase through it, and who minted it does not change when that
// happens — filtering on 'active' here would make a store link start failing
// again as soon as its first sale went through.
const resolvePricingFlowForLink = async (postId, linkAmount, pricing) => {
    if (!Number.isFinite(linkAmount) || linkAmount <= 0) return PRICING_FLOW.SHAREABLE_LINK;

    const link = await PaymentLink.findOne({ postId, amount: linkAmount, isShareableLink: true })
        .select('pricingFlow amount')
        .sort({ createdAt: -1 });

    return resolveLinkPricingFlow(link, pricing);
};

const acceptedTotalsFor = (pricing, flow) => {
    switch (flow) {
        case PRICING_FLOW.ONLINE_STORE:   return [pricing.storeTotalPrice];
        case PRICING_FLOW.ANY_LINK:       return [pricing.totalPrice, pricing.storeTotalPrice];
        case PRICING_FLOW.SHAREABLE_LINK: return [pricing.totalPrice];
        default:
            // A missing/unknown flow must never silently fall back to "accept
            // anything the server can compute" — that is the leak this fixes.
            throw new ApiError(500, "Pricing flow not specified");
    }
};

// Resolves what the buyer must actually pay for `post`. `requestedAmount` (from
// the client) is validated against the server figures for `flow` and rejected
// on mismatch, so editing the amount in the URL or the request body buys
// nothing.
const resolveChargeableAmount = (post, requestedAmount, flow) => {
    const pricing = resolvePostPricing(post);

    if (pricing.basePrice <= 0) {
        throw new ApiError(400, "This item does not have a valid price set");
    }

    const requested = Number(requestedAmount);
    if (!Number.isFinite(requested) || requested <= 0) {
        throw new ApiError(400, "Invalid amount");
    }

    const accepted = acceptedTotalsFor(pricing, flow);
    const matched = accepted.find(candidate => Math.abs(candidate - requested) < 0.01);

    if (matched === undefined) {
        throw new ApiError(400,
            `Price mismatch: this item costs ₹${accepted[0]}. Please reload the page and try again.`
        );
    }

    return { ...pricing, amount: matched };
};

// Retires pending orders whose Cashfree session provably expired. Never deletes
// them: a pending order can have money against it that the webhook still needs
// to reconcile by cashfreeOrderId.
const retireAbandonedPendingOrders = async (filter) => {
    await Order.updateMany(
        {
            ...filter,
            paymentStatus: 'pending',
            createdAt: { $lt: new Date(Date.now() - PENDING_ABANDONED_MINUTES * 60 * 1000) }
        },
        { $set: { paymentStatus: 'failed', orderStatus: 'cancelled' } }
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// GUEST CHECKOUT
//
// Everything that turns a paid guest order into an owned one — the validators,
// the consent record, account creation, the automatic refund when the email
// stopped being free mid-payment, and the summary the success page renders —
// now lives in utils/guestCheckout.utils.js.
//
// It moved because the ONLINE STORE checkout (cashfree.payment.controller.js)
// settles guest orders too and had none of it: those orders reached
// paymentStatus 'paid' with buyerId:null and stayed ownerless. Both flows run
// the same pipeline now, and a shared module is the only way that stays true —
// a second copy of "who owns this money" is how one of them silently stops
// matching reality.
// ─────────────────────────────────────────────────────────────────────────────

// Seller creates payment link to send in chat
export const createPaymentLink = asyncHandler(async (req, res) => {
    const { postId, chatId, buyerId, productName, productDescription, price, images } = req.body;
    const sellerId = req.user._id;

    if (!productName || !price) {
        throw new ApiError(400, "Product name and price are required");
    }

    let productDetails = { name: productName, description: productDescription, price, images: images || [] };
    let linkContentType = null;

    if (postId) {
        const post = await Post.findById(postId);
        // Recorded whatever the post turns out to be — including when it carries
        // no product block at all. Once the post is deleted this is the only
        // thing left that can name it in the tombstone.
        linkContentType = postContentType(post);
        if (post && post.customization?.product) {
            productDetails = {
                name: post.customization.product.name || productName,
                description: post.customization.product.description || productDescription,
                price: price || post.customization.product.price,
                images: post.customization.product.images || images || [],
                category: post.customization.product.category
            };
        }
    }

    const linkId = generateLinkId();
    const frontendUrl = getFrontendUrl();
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        buyerId,
        chatId,
        postId,
        contentType: linkContentType || undefined,
        productDetails,
        amount: productDetails.price,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        paymentUrl: `${frontendUrl}/pay/${linkId}`,
        shortUrl: `${frontendUrl}/p/${linkId}`
    });

    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    return res.status(201).json(
        new ApiResponse(201, {
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                productDetails: paymentLink.productDetails,
                amount: paymentLink.amount,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: seller._id,
                    name: seller.fullName,
                    username: seller.username,
                    avatar: seller.profileImageUrl
                }
            }
        }, "Payment link created successfully")
    );
});

// Get payment link details (for buyer to view before payment)
export const getPaymentLinkDetails = asyncHandler(async (req, res) => {
    const { linkId } = req.params;

    // postId is populated SEPARATELY, below, and only once the post is known to
    // exist. Populating it in this query would collapse "the listing was deleted"
    // and "this link never named a listing" into the same null — and the second
    // is legitimate, since a chat link can be minted from a bare product name and
    // price with no post behind it at all.
    const paymentLink = await PaymentLink.findOne({ linkId })
        .populate('sellerId', 'fullName username profileImageUrl isBlueTickVerified');

    if (!paymentLink) {
        throw new ApiError(404, "Payment link not found");
    }

    if (paymentLink.postId) {
        const linkedPost = await Post.findById(paymentLink.postId).select('contentType customization');
        if (!linkedPost) {
            return sendDeletedTombstone(res, {
                // The link records what it was minted from, so this can name the
                // thing ("This service was deleted by the owner.") instead of
                // falling back to the neutral wording. Links minted before that
                // field existed still carry nothing, and still degrade to "item".
                contentType: paymentLink.contentType,
                contentId: paymentLink.postId,
                extra: { linkId: paymentLink.linkId },
            });
        }
        // The post is still here, so the type is still knowable — record it on a
        // link that predates the field, while there is something to read it off.
        await backfillLinkContentType(paymentLink, linkedPost);
        await paymentLink.populate('postId', 'media caption');
    }

    // if (paymentLink.status === 'expired' || (paymentLink.expiresAt && new Date() > paymentLink.expiresAt)) {
    //     paymentLink.status = 'expired';
    //     await paymentLink.save();
    //     throw new ApiError(400, "Payment link has expired");
    // }

    if (paymentLink.status === 'paid') {
        throw new ApiError(400, "Payment already completed");
    }

    return res.status(200).json(
        new ApiResponse(200, { paymentLink }, "Payment link details fetched")
    );
});

// Create a Cashfree payment for a chat payment link.
//
// Named createPhonePeOrder until the non-Cashfree gateways were removed. The
// body has been pure Cashfree for a long time — the name was the last trace of
// an integration that no longer exists, and it was actively dangerous: it made
// a live money path look like dead PhonePe code to anyone grepping for gateways
// to delete.
export const createChatCashfreeOrder = asyncHandler(async (req, res) => {
    const { linkId, shippingAddress } = req.body;
    const buyerId = req.user._id;

    // Resolved by linkId ALONE, with the status checked separately below. Deleting
    // a post now cancels the links that pointed at it (post/delete.controllers.js),
    // so folding 'active' into this lookup would answer the generic "not found or
    // expired" for exactly the case the tombstone underneath exists to explain.
    const paymentLink = await PaymentLink.findOne({ linkId });
    if (!paymentLink) {
        throw new ApiError(404, "Payment link not found or expired");
    }

    // No new order may be created against a listing that has been deleted.
    // Without this an Order was minted carrying a postId that resolves to
    // nothing, and the buyer paid for something the seller had already taken
    // down.
    //
    // Only checked when the link actually names a post: a chat link created from
    // a bare product name and price has no listing behind it by design.
    if (paymentLink.postId) {
        const linkedPost = await Post.exists({ _id: paymentLink.postId });
        if (!linkedPost) {
            return sendDeletedTombstone(res, {
                contentType: paymentLink.contentType,
                contentId: paymentLink.postId,
                status: 410,
                extra: { linkId: paymentLink.linkId },
            });
        }
    }

    // Same answer the combined lookup used to give for a link that is expired,
    // cancelled or already paid — unchanged, just reached after the tombstone.
    if (paymentLink.status !== 'active') {
        throw new ApiError(404, "Payment link not found or expired");
    }

    // --- IDEMPOTENCY: block if already paid, retire stale pending on retry ---
    // A pending order is never deleted — its Cashfree session may still be live
    // and the webhook needs it to exist to record the payment.
    if (paymentLink.orderId) {
        const existingOrder = await Order.findById(paymentLink.orderId);
        if (existingOrder?.paymentStatus === 'held' || existingOrder?.paymentStatus === 'released') {
            throw new ApiError(400, "Payment for this link has already been completed");
        }
        if (existingOrder?.paymentStatus === 'pending') {
            await retireAbandonedPendingOrders({ _id: existingOrder._id });
        }
    }

    const orderNumber = generateOrderNumber();
    const order = await Order.create({
        orderNumber,
        buyerId,
        sellerId: paymentLink.sellerId,
        postId: paymentLink.postId,
        chatId: paymentLink.chatId,
        paymentLinkId: paymentLink._id,
        productDetails: paymentLink.productDetails,
        amount: paymentLink.amount,
        shippingCharges: paymentLink.shippingCharges || 0,
        gstAmount: paymentLink.gstAmount || 0,
        platformFee: 0,
        sellerAmount: paymentLink.amount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });
    paymentLink.orderId = order._id;
    await paymentLink.save();

    // ── Cashfree payment initiation ────────────────────────────────────────────
    // const merchantTransactionId = generateMerchantTransactionId();
    const cashfreeOrderId = generateCashfreeOrderId();
    const frontendUrl = getFrontendUrl();
    const backendUrl = getBackendUrl();

    let cfOrder;
    try {
        cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        paymentLink.amount,
            customerId:    buyerId.toString(),
            customerName:  req.user?.fullName || 'Customer',
            customerEmail: req.user?.email    || 'noreply@findernate.com',
            customerPhone: req.user?.phoneNumber || '9999999999',
            orderNote:     `Payment for order ${order.orderNumber}`,
            returnUrl:     `${frontendUrl}/payment/success?txnId=${cashfreeOrderId}&orderId=${order._id}`,
            notifyUrl:     `${backendUrl}/api/v1/payments/webhook`, // escrow webhook — NOT /cashfree/webhook (store only)
            expiryMinutes: 20
        });
    } catch (cfError) {
        await Order.findByIdAndDelete(order._id);
        paymentLink.orderId = null;
        await paymentLink.save();
        const errorMsg = cfError?.response?.data?.message || cfError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
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
            cashfreeOrderId,
            checkoutUrl,
            paymentSessionId,
            cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
            orderId: order._id,
            orderNumber: order.orderNumber
        }, "Cashfree payment initiated")
    );
});

// Verify Cashfree payment — chat/link flow (called after redirect from Cashfree)
export const verifyPayment = asyncHandler(async (req, res) => {
    const { txnId, cashfreeOrderId: cfIdBody, orderId } = req.body;
    const cashfreeOrderId = cfIdBody || txnId;

    if (!cashfreeOrderId || !orderId) {
        throw new ApiError(400, "txnId (cashfreeOrderId) and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    // --- IDEMPOTENCY GUARD: already verified (by this endpoint or webhook) ---
    if (order.paymentStatus === 'held' || order.paymentStatus === 'released') {
        // The payment is confirmed, so a guest order still missing its buyer
        // gets one here — this call is what heals the case where the webhook
        // marked the order paid but the account creation did not run or failed.
        // No-op once buyerId is set.
        //
        // The escrow hold is already in place on this branch (the execution that
        // banked the payment wrote it), so a refund can go straight out.
        const settled = await settleGuestOrder(order);
        // Read the account state back rather than relying on this call having
        // been the one that created it: on the common webhook-races-verify
        // ordering the account was created by the other execution, and the
        // buyer still has to be told about it.
        const guest = await describeGuestAccount(order);
        // Re-read after an auto-refund: `order` was loaded before it ran.
        const shown = settled.orphaned ? (await Order.findById(order._id)) || order : order;
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: shown._id,
                    orderNumber: shown.orderNumber,
                    orderStatus: shown.orderStatus,
                    paymentStatus: toUserPaymentStatus(shown.paymentStatus),
                    amount: shown.amount,
                    productDetails: shown.productDetails
                },
                ...guest
            }, "Payment already verified")
        );
    }

    // --- Verify with Cashfree ---
    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, "Failed to fetch order status from Cashfree");
    }

    // --- Bind the transaction to THIS order before believing anything it says ---
    //
    // This route is public and the transaction id arrives in the request body,
    // so without these two checks any anonymous caller could quote a real PAID
    // transaction of their own (a genuine ₹1 purchase, reusable forever) against
    // somebody else's pending order and settle it: the order flips to 'held',
    // the escrow ledger is credited order.amount that no money backs, and the
    // seller is told to ship. One cheap payment would settle orders of any value.
    //
    // assertTransactionBelongsToOrder throws before any state change. The legitimate
    // path is unaffected: order.cashfreeOrderId is written at order creation and the
    // Cashfree return URL carries that same id back as txnId, so they always agree.
    assertTransactionBelongsToOrder(cfOrder, order);

    if (cfOrder?.order_status !== 'PAID') {
        order.paymentStatus = 'failed';
        order.orderStatus = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    let cfPaymentId = null;
    try {
        const payments = await getCashfreePayments(cashfreeOrderId);
        const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
        cfPaymentId = paid?.cf_payment_id?.toString() || null;
    } catch { /* non-critical */ }

    // --- Atomic guard: only one of verifyPayment / webhook wins ---
    // cashfreeOrderId is deliberately NOT written here. It is set once at order
    // creation and is the value we just validated against; rewriting it from a
    // request body would let a caller re-aim the order (and the automated refund
    // that reads this field) at a transaction of their choosing.
    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId,
            paymentStatus: 'held',
            orderStatus: 'payment_received'
        },
        { new: true }
    );

    if (!updated) {
        // Webhook already processed it — re-fetch and return. The webhook also
        // wrote the escrow hold, so an auto-refund can run immediately.
        const refreshed = await Order.findById(order._id);
        const settled = await settleGuestOrder(refreshed);
        const guest = await describeGuestAccount(refreshed);
        // Re-read after an auto-refund: `refreshed` predates it.
        const shown = settled.orphaned ? (await Order.findById(refreshed._id)) || refreshed : refreshed;
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: shown._id,
                    orderNumber: shown.orderNumber,
                    orderStatus: shown.orderStatus,
                    paymentStatus: toUserPaymentStatus(shown.paymentStatus),
                    amount: shown.amount,
                    productDetails: shown.productDetails
                },
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
    // settleGuestOrder owns the ORDERING, which is not interchangeable: the
    // back-fill runs BEFORE the escrow hold (the ledger row copies
    // `order.buyerId` at write time, so holding first stamped every guest
    // order's hold with buyerId:null), and the refund runs AFTER it (it unwinds
    // the very entry the hold just made). The store checkout runs the identical
    // sequence with its own escrow write — see guestCheckout.utils.js.
    const settled = await settleGuestOrder(updated, async () => {
        const escrowWallet = await EscrowWallet.getWallet();
        await escrowWallet.holdFunds(updated, updated.amount, `Payment for order ${updated.orderNumber}`);
    });

    const guest = await describeGuestAccount(updated);

    // An auto-refund just moved this order to refunded/refunded, so the
    // in-memory snapshot taken before it is stale — report what the database
    // says, or the page tells the buyer their payment succeeded while the money
    // is on its way back.
    const shown = settled.orphaned ? (await Order.findById(updated._id)) || updated : updated;

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: shown._id,
                orderNumber: shown.orderNumber,
                orderStatus: shown.orderStatus,
                paymentStatus: toUserPaymentStatus(shown.paymentStatus),
                amount: shown.amount,
                productDetails: shown.productDetails
            },
            ...guest
        }, "Payment verified")
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/payments/webhook
// Cashfree S2S webhook — chat/escrow orders (no auth, called by Cashfree).
// Same format as /cashfree/webhook but sets paymentStatus:'held' + escrow hold.
// ─────────────────────────────────────────────────────────────────────────────
// Named phonePeWebhook until the non-Cashfree gateways were removed; it has
// only ever verified a Cashfree signature. See createChatCashfreeOrder above.
export const chatCashfreeWebhook = asyncHandler(async (req, res) => {
    // Signature is mandatory — it is the only authentication this route has.
    if (!requireCashfreeWebhookSignature(req, res, '[Cashfree chat webhook]')) return;

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
        // pass at the guest back-fill: it is a no-op once buyerId is set, and it
        // is the retry for a first delivery whose account creation failed.
        // The hold is already written on this branch, so a refund can go out.
        await settleGuestOrder(order);
        return res.status(200).json({ status: 'ok' });
    }

    const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId || null,
            paymentStatus: 'held',           // escrow — store webhook uses 'paid'
            orderStatus:   'payment_received'
        },
        { new: true }
    );

    if (updated) {
        await PaymentLink.findByIdAndUpdate(
            order.paymentLinkId,
            { status: 'paid', paidAt: new Date() }
        );
        // Confirmed payment — this is the other place a shareable order becomes
        // paid, and it may run before, after, or alongside verifyPayment. The
        // pipeline is safe in every ordering (back-fill before the hold, refund
        // after it — see settleGuestOrder).
        await settleGuestOrder(updated, async () => {
            const escrowWallet = await EscrowWallet.getWallet();
            await escrowWallet.holdFunds(updated, updated.amount, `Payment for order ${updated.orderNumber}`);
        });
    }

    return res.status(200).json({ status: 'ok' });
});

// ============================================
// SHAREABLE PAYMENT LINKS (for business accounts)
// URL format: /post/:postId/pay/:amount
// ============================================

// Business account creates a shareable payment link for a post
export const createShareablePaymentLink = asyncHandler(async (req, res) => {
    const { postId, amount } = req.body;
    const sellerId = req.user._id;

    // Validate required fields
    if (!postId || !amount) {
        throw new ApiError(400, "Post ID and amount are required");
    }

    // Validate amount. Rounded to paise here rather than later: this figure is
    // now what the buyer is actually charged, so the row and the charge must not
    // be able to differ by a rounding step.
    const numericAmount = round2(Number(amount));
    if (isNaN(numericAmount) || numericAmount <= 0) {
        throw new ApiError(400, "Amount must be a positive number");
    }

    // Check if user is a business account
    const seller = await User.findById(sellerId);
    if (!seller) {
        throw new ApiError(404, "User not found");
    }

    if (!seller.isBusinessProfile) {
        throw new ApiError(403, "Only business accounts can create shareable payment links");
    }

    // Find the post and verify ownership
    const post = await Post.findById(postId);
    if (!post) {
        throw new ApiError(404, "Post not found");
    }

    if (post.userId.toString() !== sellerId.toString()) {
        throw new ApiError(403, "You can only create payment links for your own posts");
    }

    // ── The link is minted at the LISTING's price, never at a figure the caller
    // ── chose ─────────────────────────────────────────────────────────────────
    // Sellers cannot set a custom/discounted price on a checkout link. The
    // request still carries `amount` (both clients send the listing price), but
    // it is not trusted as a price: whenever the post has a computable total,
    // THAT is what the link is minted at and the submitted figure is discarded.
    //
    // This is deliberate rather than lenient. The alternative — storing the
    // caller's figure and recomputing the real one at pay time — is what used to
    // happen, and it meant a link could quote one number and charge another. One
    // price, resolved from the listing, on both the link and the charge.
    //
    // The only case where the submitted amount survives is a post with no
    // product/service price block at all: there is nothing to mint at, so the
    // figure is kept and bounded instead.
    const listPricing = resolvePostPricing(post);
    const hasListTotal = listPricing.totalPrice > 0;
    const linkAmount = hasListTotal ? round2(listPricing.totalPrice) : numericAmount;
    if (!hasListTotal) assertLinkAmountAllowed(linkAmount);

    // Get product details from post
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: linkAmount,
        images: post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || []
    };

    // If post has product customization, use those details
    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: linkAmount, // the listing's own total
            images: post.customization.product.images || productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: linkAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Create a unique link ID
    const linkId = generateLinkId();
    const frontendUrl = getFrontendUrl();

    // Create the payment link
    const paymentLink = await PaymentLink.create({
        linkId,
        sellerId,
        postId,
        contentType: postContentType(post) || undefined,
        productDetails,
        amount: linkAmount,
        // Recorded explicitly so resolveLinkPricingFlow never has to INFER the
        // flow from the figure. Without it, a shareable link that happens to sit
        // at the store's shipping-waived total gets read as a store mint and
        // hands that waiver to the public pay URL.
        pricingFlow: PRICING_FLOW.SHAREABLE_LINK,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days expiry
        paymentUrl: `${frontendUrl}/checkout/${linkId}`,
        shortUrl: `${frontendUrl}/p/${linkId}`,
        isShareableLink: true
    });

    return res.status(201).json(
        new ApiResponse(201, {
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                postId: postId,
                // The listing's own total — which is also exactly what the buyer
                // will be charged. It can differ from the `amount` the caller
                // submitted; the caller does not set the price.
                amount: linkAmount,
                productDetails: paymentLink.productDetails,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: seller._id,
                    name: seller.fullName,
                    username: seller.username,
                    avatar: seller.profileImageUrl,
                    isBusinessProfile: seller.isBusinessProfile,
                    isBlueTickVerified: seller.isBlueTickVerified
                }
            }
        }, "Shareable payment link created successfully")
    );
});

// Get shareable payment link details (public - no auth required)
// Used when someone accesses /post/:postId/pay/:amount
export const getShareablePaymentLinkDetails = asyncHandler(async (req, res) => {
    const { postId, amount } = req.params;

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        // Somebody is holding a /post/:postId/pay/:amount URL for a listing the
        // seller has taken down. 200 with an explicit marker, not a 404: this is
        // a link that was legitimately issued, and the page has to be able to say
        // why it is empty.
        //
        // The post is gone, so the type is read back off the links that were
        // minted from it while it was alive; null just keeps the old "item"
        // wording.
        return sendDeletedTombstone(res, {
            contentType: await resolveDeletedPostContentType(postId),
            contentId: postId,
            extra: { postId, paymentLinkId: null },
        });
    }

    // Get seller details
    const seller = await User.findById(post.userId)
        .select('fullName username profileImageUrl isBusinessProfile isBlueTickVerified');

    if (!seller) {
        throw new ApiError(404, "Seller not found");
    }

    if (!seller.isBusinessProfile) {
        throw new ApiError(400, "This post is not from a business account");
    }

    // The :amount path segment is NOT the price — it is only cross-checked
    // against the post. Editing it in the address bar used to render the real
    // product beside whatever figure the visitor typed.
    //
    // ANY_LINK, not SHAREABLE_LINK, for the CROSS-CHECK: this URL is the
    // paymentUrl of a link that either flow may have minted (the online store
    // writes /post/:postId/pay/<its own total> too), so refusing the store's
    // figure here would 404-by-price a perfectly valid link.
    const pricing = resolveChargeableAmount(post, amount, PRICING_FLOW.ANY_LINK);

    // The stored link record is keyed on the figure that is IN the URL.
    const linkAmount = pricing.amount;

    // ...and the QUOTE must be the total that createShareableCashfreeOrder will
    // accept for THIS link, which depends on which checkout minted it. Quoting a
    // figure the pay endpoint rejects produced a page whose Pay button could
    // only ever answer "price mismatch … please reload" — and reloading produced
    // the same number again. The website renders a "price updated" notice when
    // the quote differs from the URL, so a correction here is visible.
    const linkFlow = await resolvePricingFlowForLink(postId, linkAmount, pricing);
    const numericAmount = acceptedTotalsFor(pricing, linkFlow)[0];

    // Build product details
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: numericAmount,
        images: post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || []
    };

    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: numericAmount,
            images: post.customization.product.images?.length ? post.customization.product.images : productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: numericAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Find if there's an existing payment link for this post/amount combination
    let paymentLink = await PaymentLink.findOne({
        postId,
        amount: linkAmount,
        status: 'active',
        isShareableLink: true
    });

    // If no existing link, return the details without a link ID
    // The frontend can still initiate payment
    return res.status(200).json(
        new ApiResponse(200, {
            postId,
            amount: numericAmount,
            // Server-resolved breakdown so the page shows exactly what will be
            // charged instead of recomputing tax/shipping with its own defaults.
            priceBreakdown: {
                basePrice:       pricing.basePrice,
                shippingCharges: round2(numericAmount - pricing.basePrice - pricing.gstAmount),
                gstPercent:      pricing.gstPercent,
                gstAmount:       pricing.gstAmount,
                totalPrice:      numericAmount,
                currency:        'INR'
            },
            productDetails,
            post: {
                _id: post._id,
                postType: post.postType,
                contentType: post.contentType,
                caption: post.caption,
                media: post.media
            },
            seller: {
                _id: seller._id,
                fullName: seller.fullName,
                username: seller.username,
                profileImageUrl: seller.profileImageUrl,
                isBusinessProfile: seller.isBusinessProfile,
                isBlueTickVerified: seller.isBlueTickVerified
            },
            paymentLinkId: paymentLink?.linkId || null
        }, "Payment details fetched successfully")
    );
});

// ============================================
// GET CHECKOUT DETAILS BY LINK ID (Public - for shareable checkout links)
// ============================================
export const getCheckoutByLinkId = asyncHandler(async (req, res) => {
    const { linkId } = req.params;

    const paymentLink = await PaymentLink.findOne({ linkId, isShareableLink: true })
        .populate('sellerId', 'fullName username profileImageUrl isBusinessProfile isBlueTickVerified');

    if (!paymentLink) {
        throw new ApiError(404, "Checkout link not found");
    }

    if (paymentLink.status === 'paid') {
        throw new ApiError(400, "Payment already completed");
    }

    // Get the post for full details
    const post = await Post.findById(paymentLink.postId);
    if (!post) {
        // The checkout link survived the listing. `canProceedToPay: false` is
        // carried alongside the marker so a page that reads `actions` before it
        // reads `deleted` still refuses to offer a Pay button.
        //
        // The link recorded what it was minted from, so the sentence can name it.
        return sendDeletedTombstone(res, {
            contentType: paymentLink.contentType || await resolveDeletedPostContentType(paymentLink.postId),
            contentId: paymentLink.postId,
            extra: {
                linkId: paymentLink.linkId,
                actions: { canProceedToPay: false, addressRequired: false, paymentLinkId: paymentLink.linkId },
            },
        });
    }

    // The post is still here, so record its type on a link minted before that
    // field existed — this read is the last chance to learn it cheaply.
    await backfillLinkContentType(paymentLink, post);

    // Build detailed product info
    let productName = paymentLink.productDetails?.name || "Product";
    let productDescription = paymentLink.productDetails?.description || "";
    let productImages = paymentLink.productDetails?.images || [];
    let productVideos = post.media?.filter(m => m.type === 'video').map(m => ({ url: m.url, thumbnailUrl: m.thumbnailUrl || '' })).filter(v => v.url) || [];
    let productCategory = paymentLink.productDetails?.category || "";
    let productType = post.contentType || "product";
    let specifications = [];
    let variants = [];
    let deliveryOptions = "offline";
    let sellerLocation = "";
    let shippingCharges = 0;
    let gstPercent = 0;

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || productCategory;
        specifications = p.specifications || [];
        variants = p.variants || [];
        deliveryOptions = p.deliveryOptions || "offline";
        shippingCharges = p.shippingCharges || 0;
        gstPercent = p.gstPercent || 0;
        if (p.location) {
            sellerLocation = p.location.name || p.location.address || p.location.city || "";
        }
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productCategory = s.category || productCategory;
        productType = "service";
        deliveryOptions = s.deliveryOptions || "offline";
        shippingCharges = (s.additionalCharges || 0) + (s.shippingCharges || 0);
        gstPercent = s.gstPercent || 0;
        if (s.location) {
            sellerLocation = s.location.name || s.location.address || s.location.city || "";
        }
    }

    // ── Price breakdown must match what create-order will actually charge ─────
    // paymentLink.amount is already a TOTAL for links minted by the checkout
    // flows, so treating it as a base price and adding shipping + GST on top
    // quoted the buyer more than the order endpoint computes. Derive the whole
    // breakdown from the post instead.
    const linkPricing = resolvePostPricing(post);
    const basePrice   = linkPricing.basePrice;
    const gstAmount   = linkPricing.gstAmount;
    gstPercent        = linkPricing.gstPercent;

    // The total THIS link's own flow charges — not the link's stored figure and
    // not ANY_LINK. This page pays through createShareableCashfreeOrder, which
    // accepts exactly one total per flow, so quoting a seller's arbitrary custom
    // amount (or the wrong flow's total) produced a page whose Pay button could
    // only ever answer "price mismatch". The stored amount is a display hint at
    // most; the post is the price, and the link says which of its two totals
    // applies.
    const totalPrice = acceptedTotalsFor(
        linkPricing,
        resolveLinkPricingFlow(paymentLink, linkPricing)
    )[0];

    shippingCharges = round2(totalPrice - basePrice - gstAmount);

    const seller = paymentLink.sellerId;

    return res.status(200).json(
        new ApiResponse(200, {
            linkId: paymentLink.linkId,
            checkoutDetails: {
                postId: paymentLink.postId,
                productName,
                productDescription,
                productImages,
                productVideos,
                productCategory,
                productType,
                specifications,
                variants,
                deliveryOptions,
                sellerLocation,
                isInStock: post.contentType === 'product' ? (post.customization?.product?.inStock ?? true) : true,
                priceBreakdown: {
                    basePrice,
                    shippingCharges: productType === 'service' ? 0 : shippingCharges,
                    additionalCharges: productType === 'service' ? shippingCharges : 0,
                    gstPercent,
                    gstAmount,
                    totalPrice,
                    currency: paymentLink.currency || 'INR'
                },
                seller: {
                    _id: seller._id,
                    fullName: seller.fullName,
                    username: seller.username,
                    profileImageUrl: seller.profileImageUrl
                },
                checkoutStatus: paymentLink.status === 'active' ? 'pending' : paymentLink.status,
                expiresAt: paymentLink.expiresAt
            },
            userRole: 'buyer',
            checkoutPolicies: {
                shippingPolicy: {
                    estimatedDeliveryDays: '5-10',
                    maxShippingDays: 15,
                    description: 'Shipping is handled by the seller. Estimated delivery is 5-10 business days depending on your location. Tracking details will be shared once shipped.'
                },
                returnPolicy: {
                    maxReturnDays: 7,
                    returnConditions: [
                        'Item must be unused, unworn and in original packaging',
                        'Return request must be raised within 7 days of delivery',
                        'Record a video while opening the package for dispute support',
                        'Refunds are processed within 5-7 business days after return approval',
                        'Shipping costs for returns may be borne by the buyer unless the item is defective'
                    ],
                    description: 'Returns accepted within 7 days of delivery for eligible items. Items must be in original condition with tags and packaging intact.'
                },
                buyerNotices: [
                    // {
                        // type: 'escrow_protection',
                        // title: 'Escrow Payment Protection',
                        // // message: 'Your payment is held securely in escrow and only released to the seller after you confirm delivery. If there is any issue, you can raise a dispute.',
                        // priority: 'medium'
                    // },
                    {
                        type: 'package_opening',
                        title: 'Record Package Opening',
                        message: 'We strongly recommend recording a video while opening your package. This is required as evidence if you need to file a return or dispute.',
                        priority: 'high'
                    },
                    {
                        type: 'fraud_warning',
                        title: 'Fraudulent Payment Warning',
                        message: 'Any fraudulent, unauthorized, or deceptive payment activity will result in immediate account suspension and legal action under applicable laws including the IT Act, 2000 and Indian Penal Code.',
                        priority: 'critical',
                        displayStyle: 'red'
                    }
                ]
            },
            actions: {
                canProceedToPay: paymentLink.status === 'active',
                addressRequired: true,
                paymentLinkId: paymentLink.linkId
            }
        }, "Checkout details fetched")
    );
});

// Create Cashfree payment for a shareable payment link.
// Signed-in buyers and guests both land here; a guest additionally supplies
// buyerDetails (name, email, phone, 13+ attestation, terms acceptance).
// Named createShareablePhonePeOrder until the non-Cashfree gateways were
// removed; the body is pure Cashfree. See createChatCashfreeOrder above.
export const createShareableCashfreeOrder = asyncHandler(async (req, res) => {
    // Any `linkId` in the body is IGNORED. It was read here while sellers could
    // price their own links; that feature is gone, and the amount is recomputed
    // from the Post on every payment. Accepting it silently rather than 400ing
    // keeps already-shipped app builds working — they still send it.
    const { postId, amount, buyerDetails, shippingAddress } = req.body;
    const buyerId = req.user?._id; // May be null for guest checkout

    // Validate required fields
    if (!postId || !amount) {
        throw new ApiError(400, "Post ID and amount are required");
    }

    // Ported from createOnlineStoreOrder: this endpoint wrote req.body straight
    // into the Order, so a partial address produced a PAID, unshippable order.
    assertCompleteShippingAddress(shippingAddress);

    // Shape/consent validation only — it touches no database and so leaks
    // nothing about which addresses exist.
    if (!buyerId) {
        assertGuestBuyerDetails(buyerDetails);
    }

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        // 410, not 200: this call CREATES an order, and there is nothing left to
        // buy. Same body as the read endpoints so the checkout page can show the
        // same sentence instead of a generic failure toast. The type is read back
        // off the links minted from the post while it still existed.
        return sendDeletedTombstone(res, {
            contentType: await resolveDeletedPostContentType(postId),
            contentId: postId,
            status: 410,
        });
    }

    // Get seller
    const seller = await User.findById(post.userId);
    if (!seller || !seller.isBusinessProfile) {
        throw new ApiError(400, "Invalid seller or not a business account");
    }

    // ── Server-authoritative amount ────────────────────────────────────────────
    // The body `amount` is a cross-check only. It used to be written straight
    // into the Order and sent to Cashfree, so a replayed request with amount=1
    // bought a ₹45,000 item for ₹1.
    //
    // WHICH total is legitimate depends on which checkout minted the link this
    // request is paying — the store waives shipping at ≥ ₹499, the shareable
    // link never does. Hard-coding SHAREABLE_LINK here made every store-minted
    // /post/:postId/pay/<store total> URL permanently unpayable. The flow is
    // therefore read off the stored link (resolvePricingFlowForLink), and falls
    // back to SHAREABLE_LINK when no link carries this figure — so submitting
    // the store's discounted total for a post the store does not sell at that
    // price is still rejected.
    const postPricing = resolvePostPricing(post);

    // ── NO PRICE EVER COMES FROM THE REQUEST ─────────────────────────────────
    // Sellers cannot set a custom price on a checkout link, so there is nothing
    // here to read one out of: the chargeable total is recomputed from the Post
    // on every payment, and the buyer's `amount` is only ever cross-checked
    // against it. This is the guard that stops a buyer paying ₹1 for a ₹48,000
    // listing, and it has no exceptions.
    const requestedTotal = round2(Number(amount));
    const pricingFlow    = await resolvePricingFlowForLink(postId, requestedTotal, postPricing);
    const pricing        = resolveChargeableAmount(post, amount, pricingFlow);
    const numericAmount  = pricing.amount;

    // ── Existing-email HARD STOP ─────────────────────────────────────────────
    // No order is created, nothing is attached, no token is issued. The website
    // sends the buyer to sign in and come back.
    //
    // DELIBERATELY AFTER THE POST AND PRICE RESOLUTION. The 409 this can throw
    // is an account-existence oracle, and while it sat at the top of the
    // handler an attacker could probe any address with a request carrying no
    // valid product at all. Now a probe costs a real postId belonging to a real
    // business account, at the real price — which is also what makes the
    // per-IP checkout limiter (the only limiter that can see enumeration; see
    // rateLimiter.middleware.js) meaningful, since each probe must now pass
    // every check above.
    let guestEmail = null;
    if (!buyerId) {
        guestEmail = await assertGuestEmailUnclaimed(buyerDetails.email);
    }

    // Build product details
    let productDetails = {
        name: post.caption || "Product",
        description: post.description || "",
        price: numericAmount,
        images: post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || []
    };

    if (post.customization?.product) {
        productDetails = {
            name: post.customization.product.name || productDetails.name,
            description: post.customization.product.description || productDetails.description,
            price: numericAmount,
            images: post.customization.product.images?.length ? post.customization.product.images : productDetails.images,
            category: post.customization.product.category
        };
    } else if (post.customization?.service) {
        productDetails = {
            name: post.customization.service.name || productDetails.name,
            description: post.customization.service.description || productDetails.description,
            price: numericAmount,
            images: productDetails.images,
            category: post.customization.service.category
        };
    }

    // Find or create payment link. A seller-set link was resolved above and is
    // the one being paid — never look for another at the same figure.
    let paymentLink = sellerSetLink || await PaymentLink.findOne({
        postId,
        amount: numericAmount,
        status: 'active',
        isShareableLink: true
    });

    if (!paymentLink) {
        const newLinkId = generateLinkId();
        const frontendUrl = getFrontendUrl();
        paymentLink = await PaymentLink.create({
            linkId: newLinkId,
            sellerId: seller._id,
            postId,
            contentType: postContentType(post) || undefined,
            productDetails,
            amount: numericAmount,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${numericAmount}`,
            shortUrl: `${frontendUrl}/p/${newLinkId}`,
            isShareableLink: true,
            // Record which total this URL was minted at, so re-opening it later
            // resolves back to the same flow instead of being guessed.
            pricingFlow
        });
    }

    // Check if link is expired
    // if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    //     paymentLink.status = 'expired';
    //     await paymentLink.save();
    //     throw new ApiError(400, "Payment link has expired");
    // }

    // --- DOUBLE BOOKING GUARD + IDEMPOTENCY ---
    // An older 'pending' order is NOT deleted: its Cashfree session may still be
    // live and the buyer may be approving that payment right now. Deleting it
    // left the webhook with no order to credit and the buyer charged for
    // nothing. Only provably-expired sessions are retired.
    if (buyerId) {
        await retireAbandonedPendingOrders({ postId, buyerId });

        const settledOrder = await Order.findOne({
            postId,
            buyerId,
            amount: numericAmount,
            paymentStatus: { $in: ['held', 'released'] }
        });
        if (settledOrder) {
            throw new ApiError(400, "You have already purchased this product");
        }
    }

    const order = await Order.create({
        orderNumber: generateOrderNumber(),
        buyerId: buyerId || null,
        // Store the NORMALISED email: the account is created from this value
        // after payment, and every later lookup goes through Mongoose, which
        // lowercases its filters.
        buyerDetails: !buyerId ? {
            fullName:    buyerDetails.fullName,
            email:       guestEmail,
            phoneNumber: buyerDetails.phoneNumber
        } : undefined,
        sellerId: seller._id,
        postId,
        paymentLinkId: paymentLink._id,
        productDetails,
        amount: numericAmount,
        shippingCharges: round2(numericAmount - pricing.basePrice - pricing.gstAmount),
        gstAmount: pricing.gstAmount,
        platformFee: 0,
        sellerAmount: numericAmount,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending',
        isShareableOrder: true
    });

    if (!buyerId) {
        // LEGAL EVIDENCE for the 13+ attestation and the terms acceptance the
        // guest just ticked. It has to survive until the payment is confirmed,
        // because that is when the account is created and the permanent record
        // is written from it. Same helper — and therefore the same shape — as
        // the online-store checkout, so anything that ever has to produce this
        // record reads one format. See guestCheckout.utils.js.
        await recordGuestConsent(order._id, buyerDetails, req, GUEST_CONSENT_SOURCE.SHAREABLE_LINK);
    }

    // ── Cashfree payment initiation ────────────────────────────────────────────
    // const merchantTransactionId = generateMerchantTransactionId();
    const cashfreeOrderId = generateCashfreeOrderId();
    const frontendUrl = getFrontendUrl();
    const backendUrl  = getBackendUrl();

    const customerName  = buyerDetails?.fullName || req.user?.fullName || 'Customer';
    const customerEmail = buyerDetails?.email     || req.user?.email    || 'noreply@findernate.com';
    const customerPhone = buyerDetails?.phoneNumber || req.user?.phoneNumber || '9999999999';
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
            returnUrl:     `${frontendUrl}/payment/success?txnId=${cashfreeOrderId}&orderId=${order._id}`,
            notifyUrl:     `${backendUrl}/api/v1/payments/webhook`, // escrow webhook — NOT /cashfree/webhook (store only)
            expiryMinutes: 20
        });
    } catch (cfError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = cfError?.response?.data?.message || cfError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

    const paymentSessionId = cfOrder?.payment_session_id;
    if (!paymentSessionId) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment session from Cashfree");
    }

    order.cashfreeOrderId = cashfreeOrderId;
    await order.save();

    paymentLink.orderId = order._id;
    await paymentLink.save();

    const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);

    return res.status(200).json(
        new ApiResponse(200, {
            cashfreeOrderId,
            checkoutUrl,
            paymentSessionId,
            cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
            orderId: order._id,
            orderNumber: order.orderNumber,
            amount: numericAmount,  // server-resolved; this is what Cashfree will charge
            priceBreakdown: {
                basePrice:       pricing.basePrice,
                shippingCharges: round2(numericAmount - pricing.basePrice - pricing.gstAmount),
                gstPercent:      pricing.gstPercent,
                gstAmount:       pricing.gstAmount,
                totalPrice:      numericAmount,
                currency:        'INR'
            },
            seller: {
                name: seller.fullName,
                username: seller.username
            }
        }, "Cashfree payment initiated for shareable link")
    );
});

// ============================================
// BUYER INTEREST - Auto payment link in chat
// ============================================

// Helper to emit socket events safely
const safeEmitToChat = (chatId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToChat(chatId, event, data);
    }
};

const safeEmitToUser = (userId, event, data) => {
    if (socketManager.isReady()) {
        socketManager.emitToUser(userId, event, data);
    }
};

// Buyer shows interest in a product - auto-creates payment link & sends message in chat
export const showProductInterest = asyncHandler(async (req, res) => {
    const { postId, chatId } = req.body;
    const buyerId = req.user._id;

    if (!postId || !chatId) {
        throw new ApiError(400, "Post ID and Chat ID are required");
    }

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
        // Reached from a product card in a chat, which can outlive the listing.
        // 410 with the marker: this mints a payment link, so it cannot succeed.
        return sendDeletedTombstone(res, {
            contentType: await resolveDeletedPostContentType(postId),
            contentId: postId,
            status: 410,
        });
    }

    const sellerId = post.userId;

    // Don't create payment link for own products
    if (sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot create payment link for your own product");
    }

    // Verify the chat exists and buyer is a participant
    const chat = await Chat.findOne({
        _id: chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(404, "Chat not found or access denied");
    }

    // Build product details from post
    let productName = "Product";
    let productDescription = post.caption || "";
    let productPrice = 0;
    let productImages = post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || [];
    let productCategory = "";
    let productType = post.contentType || "product";

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productPrice = p.price || 0;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || "";
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productPrice = s.price || 0;
        productCategory = s.category || "";
        productType = "service";
    }

    // If no price, return negotiation mode
    if (!productPrice || productPrice <= 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                purchaseMode: 'negotiation',
                productSummary: {
                    postId: post._id,
                    name: productName,
                    description: productDescription,
                    price: 0,
                    currency: 'INR',
                    category: productCategory,
                    images: productImages,
                    thumbnail: productImages[0] || '',
                    purchaseMode: 'negotiation',
                    seller: { _id: sellerId }
                },
                messageSent: false,
                message: "Product has no fixed price. Negotiate in chat."
            }, "Negotiation mode - no fixed price")
        );
    }

    // Check if payment link already exists for this post+chat combination
    let paymentLink = await PaymentLink.findOne({
        postId,
        chatId,
        buyerId,
        status: 'active'
    });

    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    const frontendUrl = getFrontendUrl();

    if (!paymentLink) {
        // Create new payment link
        const linkId = generateLinkId();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId,
            buyerId,
            chatId,
            postId,
            contentType: postContentType(post) || undefined,
            productDetails: {
                name: productName,
                description: productDescription,
                price: productPrice,
                images: productImages,
                category: productCategory
            },
            amount: productPrice,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${productPrice}`,
            shortUrl: `${frontendUrl}/p/${linkId}`
        });
    } else {
        // Always update payment link URL and product details to use current FRONTEND_URL and latest data
        let needsSave = false;

        const correctUrl = `${frontendUrl}/post/${postId}/pay/${paymentLink.amount}`;
        if (paymentLink.paymentUrl !== correctUrl) {
            paymentLink.paymentUrl = correctUrl;
            needsSave = true;
        }

        if (paymentLink.amount !== productPrice) {
            paymentLink.productDetails.name = productName;
            paymentLink.productDetails.description = productDescription;
            paymentLink.productDetails.price = productPrice;
            paymentLink.productDetails.images = productImages;
            paymentLink.productDetails.category = productCategory;
            paymentLink.amount = productPrice;
            paymentLink.paymentUrl = `${frontendUrl}/post/${postId}/pay/${productPrice}`;
            needsSave = true;
        }

        if (needsSave) await paymentLink.save();
    }

    // Always send payment link message in chat (every time buyer shows interest)
    const paymentMessage = `💰 Pay for "${productName}" - ₹${productPrice}\n\nClick below to pay securely.`;

    const recipients = chat.participants.filter(
        p => p.toString() !== sellerId.toString()
    );

    const autoMessage = await Message.create({
        chatId,
        sender: sellerId, // Message appears from seller (automated)
        message: paymentMessage,
        messageType: 'payment_link',
        timestamp: new Date(),
        readBy: [sellerId],
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        })),
        productReference: {
            postId: post._id,
            productName,
            productImage: productImages[0] || '',
            productVideos: post.media?.filter(m => m.type === 'video').map(m => ({ url: m.url, thumbnailUrl: m.thumbnailUrl || '' })).filter(v => v.url) || [],
            productPrice,
            productType,
            productDescription,
        },
        linkPreview: {
            url: paymentLink.paymentUrl,
            title: `Pay ₹${productPrice} for ${productName}`,
            description: productDescription,
            image: productImages[0] || '',
            siteName: 'Findernate Pay'
        }
    });

    // Update chat's last message
    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: sellerId,
        message: paymentMessage,
        timestamp: new Date()
    };
    chat.lastMessageId = autoMessage._id;
    await chat.save();

    // Populate and emit via socket
    const populatedMessage = await Message.findById(autoMessage._id)
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    // Emit to chat room (for users already in the room)
    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    // Also emit directly to buyer's user room to ensure they receive the payment link
    // message even if they haven't joined the chat socket room yet
    safeEmitToUser(buyerId.toString(), 'new_message', {
        chatId,
        message: populatedMessage
    });

    return res.status(200).json(
        new ApiResponse(200, {
            purchaseMode: 'direct',
            productSummary: {
                postId: post._id,
                name: productName,
                description: productDescription,
                price: productPrice,
                currency: 'INR',
                category: productCategory,
                images: productImages,
                thumbnail: productImages[0] || '',
                purchaseMode: 'direct',
                seller: {
                    _id: sellerId,
                    fullName: seller?.fullName,
                    username: seller?.username,
                    profileImageUrl: seller?.profileImageUrl
                }
            },
            paymentLink: {
                linkId: paymentLink.linkId,
                paymentUrl: paymentLink.paymentUrl,
                shortUrl: paymentLink.shortUrl,
                amount: paymentLink.amount,
                expiresAt: paymentLink.expiresAt,
                seller: {
                    id: sellerId,
                    name: seller?.fullName,
                    username: seller?.username,
                    avatar: seller?.profileImageUrl
                }
            },
            autoMessage: populatedMessage,
            messageSent: true,
            message: "Payment link sent to buyer in chat"
        }, "Payment link created and sent")
    );
});

// ============================================
// CHECKOUT MESSAGE - Send rich checkout card in chat
// ============================================

export const sendCheckoutMessage = asyncHandler(async (req, res) => {
    const { postId, chatId } = req.body;
    const buyerId = req.user._id;

    if (!postId || !chatId) {
        throw new ApiError(400, "Post ID and Chat ID are required");
    }

    // Find the post with full details
    const post = await Post.findById(postId);
    if (!post) {
        // 410 with the marker: this writes a checkout message into the chat, and
        // there is no longer a listing to check out.
        return sendDeletedTombstone(res, {
            contentType: await resolveDeletedPostContentType(postId),
            contentId: postId,
            status: 410,
        });
    }

    const sellerId = post.userId;

    // Don't allow self-checkout
    if (sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot checkout your own product");
    }

    // Verify the chat exists and buyer is a participant
    const chat = await Chat.findOne({
        _id: chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(404, "Chat not found or access denied");
    }

    // Extract product details
    let productName = "Product";
    let productDescription = post.caption || "";
    let productPrice = 0;
    let productImages = post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || [];
    let productCategory = "";
    let productType = post.contentType || "product";
    let specifications = [];
    let variants = [];
    let deliveryOptions = "offline";
    let sellerLocation = "";
    let currency = "INR";
    let shippingCharges = 0;
    let gstPercent = 0;

    if (post.customization?.product) {
        const p = post.customization.product;
        productName = p.name || productName;
        productDescription = p.description || productDescription;
        productPrice = p.price || 0;
        productImages = p.images?.length ? p.images : productImages;
        productCategory = p.category || "";
        specifications = p.specifications || [];
        variants = p.variants || [];
        deliveryOptions = p.deliveryOptions || "offline";
        currency = p.currency || "INR";
        shippingCharges = p.shippingCharges || 0;
        gstPercent = p.gstPercent || 0;
        if (p.location) {
            sellerLocation = p.location.name || p.location.address || p.location.city || "";
        }
    } else if (post.customization?.service) {
        const s = post.customization.service;
        productName = s.name || productName;
        productDescription = s.description || productDescription;
        productPrice = s.price || 0;
        productCategory = s.category || "";
        productType = "service";
        deliveryOptions = s.deliveryOptions || "offline";
        currency = s.currency || "INR";
        // additionalCharges is the primary extra-fee field for services; shippingCharges covers physical delivery if any
        shippingCharges = (s.additionalCharges || 0) + (s.shippingCharges || 0);
        gstPercent = s.gstPercent || 0;
        if (s.location) {
            sellerLocation = s.location.name || s.location.address || s.location.city || "";
        }
    }

    // If no price, return negotiation mode
    if (!productPrice || productPrice <= 0) {
        return res.status(200).json(
            new ApiResponse(200, {
                purchaseMode: 'negotiation',
                message: "Product has no fixed price. Negotiate in chat."
            }, "Negotiation mode - no fixed price")
        );
    }

    // Calculate price breakdown using seller-provided GST & shipping
    const basePrice = productPrice;
    const gstAmount = parseFloat(((basePrice * gstPercent) / 100).toFixed(2));
    const totalPrice = parseFloat((basePrice + shippingCharges + gstAmount).toFixed(2));

    // Get seller info
    const seller = await User.findById(sellerId).select('fullName username profileImageUrl');

    // Create or reuse payment link
    const frontendUrl = getFrontendUrl();

    let paymentLink = await PaymentLink.findOne({
        postId,
        chatId,
        buyerId,
        status: 'active'
    });

    if (!paymentLink) {
        const linkId = generateLinkId();
        paymentLink = await PaymentLink.create({
            linkId,
            sellerId,
            buyerId,
            chatId,
            postId,
            contentType: postContentType(post) || undefined,
            productDetails: {
                name: productName,
                description: productDescription,
                price: totalPrice,
                images: productImages,
                category: productCategory
            },
            amount: totalPrice,
            shippingCharges,
            gstAmount,
            gstPercent,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            paymentUrl: `${frontendUrl}/post/${postId}/pay/${totalPrice}`,
            shortUrl: `${frontendUrl}/p/${linkId}`
        });
    } else {
        // Update if needed
        const correctUrl = `${frontendUrl}/post/${postId}/pay/${totalPrice}`;
        if (paymentLink.paymentUrl !== correctUrl || paymentLink.amount !== totalPrice) {
            paymentLink.amount = totalPrice;
            paymentLink.shippingCharges = shippingCharges;
            paymentLink.gstAmount = gstAmount;
            paymentLink.gstPercent = gstPercent;
            paymentLink.paymentUrl = correctUrl;
            paymentLink.productDetails = {
                name: productName,
                description: productDescription,
                price: totalPrice,
                images: productImages,
                category: productCategory
            };
            await paymentLink.save();
        }
    }

    // Build the checkout message
    const shippingLabel = productType === 'service' ? 'Additional Charges' : 'Shipping';
    const checkoutText = `🛒 Checkout for "${productName}"\n\nBase Price: ₹${basePrice.toLocaleString('en-IN')}\n${shippingLabel}: ${shippingCharges > 0 ? '₹' + shippingCharges.toLocaleString('en-IN') : 'FREE'}\nGST (${gstPercent}%): ₹${gstAmount.toLocaleString('en-IN')}\n\n💰 Total: ₹${totalPrice.toLocaleString('en-IN')}`;

    const recipients = chat.participants.filter(
        p => p.toString() !== sellerId.toString()
    );

    const checkoutMessage = await Message.create({
        chatId,
        sender: sellerId, // Message appears from seller (automated)
        message: checkoutText,
        messageType: 'checkout',
        timestamp: new Date(),
        readBy: [sellerId],
        deliveryStatus: recipients.map(recipientId => ({
            userId: recipientId,
            status: 'sent',
            deliveredAt: null,
            seenAt: null
        })),
        productReference: {
            postId: post._id,
            productName,
            productImage: productImages[0] || '',
            productVideos: post.media?.filter(m => m.type === 'video').map(m => ({ url: m.url, thumbnailUrl: m.thumbnailUrl || '' })).filter(v => v.url) || [],
            productPrice: totalPrice,
            productType,
            productDescription,
        },
        checkoutDetails: {
            postId: post._id,
            productName,
            productDescription,
            productImages,
            productCategory,
            productType,
            specifications,
            variants,
            deliveryOptions,
            sellerLocation,
            basePrice,
            shippingCharges,
            gstPercent,
            gstAmount,
            totalPrice,
            currency,
            sellerId,
            sellerName: seller?.fullName || '',
            sellerUsername: seller?.username || '',
            sellerAvatar: seller?.profileImageUrl || '',
            paymentLinkId: paymentLink.linkId,
            paymentUrl: '', // Will be set after message creation with messageId
            checkoutStatus: 'pending',
            expiresAt: paymentLink.expiresAt
        }
    });

    // Update paymentUrl to point to the full checkout page using messageId
    const checkoutPageUrl = `${frontendUrl}/checkout/${checkoutMessage._id}`;
    checkoutMessage.checkoutDetails.paymentUrl = checkoutPageUrl;
    await checkoutMessage.save();

    // Update chat's last message
    chat.lastMessageAt = new Date();
    chat.lastMessage = {
        sender: sellerId,
        message: `🛒 Checkout: ${productName} - ₹${totalPrice.toLocaleString('en-IN')}`,
        timestamp: new Date()
    };
    chat.lastMessageId = checkoutMessage._id;
    await chat.save();

    // Populate and emit via socket
    const populatedMessage = await Message.findById(checkoutMessage._id)
        .populate('sender', 'username fullName profileImageUrl')
        .lean();

    // Emit to chat room
    safeEmitToChat(chatId, 'new_message', {
        chatId,
        message: populatedMessage
    });

    // Also emit directly to buyer
    safeEmitToUser(buyerId.toString(), 'new_message', {
        chatId,
        message: populatedMessage
    });

    return res.status(200).json(
        new ApiResponse(200, {
            purchaseMode: 'direct',
            checkoutMessage: populatedMessage,
            messageSent: true,
            message: "Checkout sent to buyer in chat",
            actions: {
                canProceedToPay: true,
                addressRequired: true,
                checkoutMessageId: checkoutMessage._id,
                paymentLinkId: paymentLink.linkId,
                totalPrice,
                currency
            }
        }, "Checkout message sent successfully")
    );
});

// ============================================
// E-COMMERCE CHECKOUT FLOW (Flipkart/Myntra style)
// ============================================

// GET checkout details from a checkout message (buyer views before paying)
export const getCheckoutDetails = asyncHandler(async (req, res) => {
    const { messageId } = req.params;
    const userId = req.user._id;

    const message = await Message.findOne({
        _id: messageId,
        messageType: 'checkout',
        isDeleted: false
    }).populate('sender', 'username fullName profileImageUrl isBlueTickVerified');

    if (!message) {
        throw new ApiError(404, "Checkout message not found");
    }

    // Verify user is a participant in this chat
    const chat = await Chat.findOne({
        _id: message.chatId,
        participants: userId
    });

    if (!chat) {
        throw new ApiError(403, "Access denied");
    }

    const checkout = message.checkoutDetails;

    // Determine user role
    const isSeller = checkout.sellerId?.toString() === userId.toString();
    const userRole = isSeller ? 'seller' : 'buyer';
    const post = await Post.findById(checkout.postId);
    if (!post) {
        // The checkout message stored productType at send time, so this is one of
        // the few places the type of a deleted listing is still known — the
        // tombstone can name it ("This service was deleted by the owner.")
        // instead of falling back to the neutral wording.
        return sendDeletedTombstone(res, {
            contentType: checkout?.productType,
            contentId: checkout.postId,
            extra: {
                messageId: message._id,
                chatId: message.chatId,
                userRole,
                actions: { canProceedToPay: false, addressRequired: false, paymentLinkId: checkout.paymentLinkId },
            },
        });
    }

    // Always derive fresh media from the post so images/videos are current
    let productImages = post.media?.filter(m => m.type === 'image').map(m => m.url).filter(Boolean) || [];
    const productVideos = post.media?.filter(m => m.type === 'video').map(m => ({ url: m.url, thumbnailUrl: m.thumbnailUrl || '' })).filter(v => v.url) || [];
    // Fall back to stored images if post has none (e.g. customization-only products)
    if (productImages.length === 0 && checkout.productImages?.length) {
        productImages = checkout.productImages.filter(url => !/\.(mp4|mov|webm|ogg)(\?.*)?$/i.test(url));
    }

    return res.status(200).json(
        new ApiResponse(200, {
            messageId: message._id,
            chatId: message.chatId,
            userRole,
            checkoutDetails: {
                postId: checkout.postId,
                productName: checkout.productName,
                productDescription: checkout.productDescription,
                productImages,
                productVideos,
                productCategory: checkout.productCategory,
                productType: checkout.productType,
                specifications: checkout.specifications,
                variants: checkout.variants,
                deliveryOptions: checkout.deliveryOptions,
                sellerLocation: checkout.sellerLocation,
                isInStock: post.contentType === 'product' ? (post.customization?.product?.inStock ?? true) : true,
                priceBreakdown: {
                    basePrice: checkout.basePrice,
                    shippingCharges: checkout.productType === 'service' ? 0 : (checkout.shippingCharges || 0),
                    additionalCharges: checkout.productType === 'service' ? (checkout.shippingCharges || 0) : 0,
                    gstPercent: checkout.gstPercent,
                    gstAmount: checkout.gstAmount,
                    totalPrice: checkout.totalPrice,
                    currency: checkout.currency
                },
                seller: {
                    _id: checkout.sellerId,
                    fullName: checkout.sellerName,
                    username: checkout.sellerUsername,
                    profileImageUrl: checkout.sellerAvatar
                },
                checkoutStatus: checkout.checkoutStatus,
                expiresAt: checkout.expiresAt
            },
            checkoutPolicies: {
                shippingPolicy: {
                    estimatedDeliveryDays: '5-10',
                    maxShippingDays: 15,
                    description: 'Shipping is handled by the seller. Estimated delivery is 5-10 business days depending on your location. Tracking details will be shared once shipped.'
                },
                returnPolicy: {
                    maxReturnDays: 7,
                    returnConditions: [
                        'Item must be unused, unworn and in original packaging',
                        'Return request must be raised within 7 days of delivery',
                        'Record a video while opening the package for dispute support',
                        'Refunds are processed within 5-7 business days after return approval',
                        'Shipping costs for returns may be borne by the buyer unless the item is defective'
                    ],
                    description: 'Returns accepted within 7 days of delivery for eligible items. Items must be in original condition with tags and packaging intact.'
                },
                buyerNotices: !isSeller ? [
                    // {
                        // type: 'escrow_protection',
                        // title: 'Escrow Payment Protection',
                        // // message: 'Your payment is held securely in escrow and only released to the seller after you confirm delivery. If there is any issue, you can raise a dispute.',
                        // priority: 'medium'
                    // },
                    {
                        type: 'package_opening',
                        title: 'Record Package Opening',
                        message: 'We strongly recommend recording a video while opening your package. This is required as evidence if you need to file a return or dispute.',
                        priority: 'high'
                    },
                    {
                        type: 'fraud_warning',
                        title: 'Fraudulent Payment Warning',
                        message: 'Any fraudulent, unauthorized, or deceptive payment activity will result in immediate account suspension and legal action under applicable laws including the IT Act, 2000 and Indian Penal Code.',
                        priority: 'critical',
                        displayStyle: 'red'
                    }
                ] : [],
                sellerNotices: isSeller ? [
                    {
                        type: 'seller_info',
                        title: 'Seller View',
                        message: 'You are viewing this checkout as the seller. You cannot purchase your own product. Share this checkout link with your buyers.',
                        priority: 'medium'
                    }
                ] : []
            },
            actions: {
                canProceedToPay: checkout.checkoutStatus === 'pending',
                addressRequired: true,
                paymentLinkId: checkout.paymentLinkId
            }
        }, "Checkout details fetched")
    );
});

// Buyer initiates payment from checkout message (like clicking "Proceed to Pay")
export const initiateCheckoutPayment = asyncHandler(async (req, res) => {
    const { messageId, shippingAddress } = req.body;
    const buyerId = req.user._id;

    if (!messageId) {
        throw new ApiError(400, "Checkout message ID is required");
    }
    // Find the checkout message
    const message = await Message.findOne({
        _id: messageId,
        messageType: 'checkout',
        isDeleted: false
    });
    
    if (!message) {
        throw new ApiError(404, "Checkout message not found");
    }

    // Chat membership is settled BEFORE anything is read out of the checkout.
    // It used to sit below the post lookup, so a caller who was not in the chat
    // still learned the product type of any checkout message id they guessed;
    // the tombstone below reports on the referenced post, and a non-participant
    // has no business being told about it either.
    const chat = await Chat.findOne({
        _id: message.chatId,
        participants: buyerId
    });

    if (!chat) {
        throw new ApiError(403, "Access denied");
    }

    const post = await Post.findById(message.checkoutDetails.postId);
    if (!post) {
        // 410 with the marker: this is the "Proceed to Pay" call, so no order may
        // be created — but the buyer is told exactly why, naming the type the
        // checkout message recorded.
        return sendDeletedTombstone(res, {
            contentType: message.checkoutDetails.productType,
            contentId: message.checkoutDetails.postId,
            status: 410,
            extra: { messageId: message._id },
        });
    }
    if (post.contentType === "product" && post.customization?.product?.inStock === false) {
        throw new ApiError(400, "Product is Out of stock");
    }
    const checkout = message.checkoutDetails;

    // Don't let seller pay themselves
    if (checkout.sellerId.toString() === buyerId.toString()) {
        throw new ApiError(400, "Cannot pay for your own product");
    }

    // Check checkout status
    if (checkout.checkoutStatus === 'paid') {
        throw new ApiError(400, "This checkout has already been paid");
    }

    // Always validate shipping address
    if (!shippingAddress) {
        throw new ApiError(400, "Shipping address is required");
    }

    if (!shippingAddress.fullName || !shippingAddress.phoneNumber || !shippingAddress.addressLine1 || !shippingAddress.city || !shippingAddress.state || !shippingAddress.postalCode) {
        throw new ApiError(400, "Please provide complete shipping address (name, phone, address, city, state, pincode)");
    }

    // Find or reuse payment link
    const paymentLink = await PaymentLink.findOne({
        linkId: checkout.paymentLinkId,
        status: 'active'
    });

    if (!paymentLink) {
        throw new ApiError(400, "Payment link expired or not found. Ask seller to resend checkout.");
    }

    // --- DOUBLE BOOKING GUARD + IDEMPOTENCY ---
    // Pending orders are retired only once their gateway session has expired;
    // deleting an in-flight one orphaned real payments.
    await retireAbandonedPendingOrders({ paymentLinkId: paymentLink._id, buyerId });

    const settledCheckoutOrder = await Order.findOne({
        paymentLinkId: paymentLink._id,
        buyerId,
        paymentStatus: { $in: ['held', 'released'] }
    });
    if (settledCheckoutOrder) {
        throw new ApiError(400, "Payment for this checkout has already been completed");
    }

    const order = await Order.create({
        orderNumber: generateOrderNumber(),
        buyerId,
        sellerId: checkout.sellerId,
        postId: checkout.postId,
        chatId: message.chatId,
        paymentLinkId: paymentLink._id,
        productDetails: {
            name: checkout.productName,
            description: checkout.productDescription,
            price: checkout.totalPrice,
            images: checkout.productImages,
            category: checkout.productCategory
        },
        amount: checkout.totalPrice,
        platformFee: 0,
        sellerAmount: checkout.totalPrice,
        shippingAddress,
        orderStatus: 'payment_pending',
        paymentStatus: 'pending'
    });
    paymentLink.orderId = order._id;
    await paymentLink.save();

    const cashfreeOrderId = generateCashfreeOrderId();
    const frontendUrl = getFrontendUrl();
    const backendUrl  = getBackendUrl();

    let cfOrder;
    try {
        cfOrder = await createCashfreeOrder({
            orderId:       cashfreeOrderId,
            amount:        checkout.totalPrice,
            customerId:    buyerId.toString(),
            customerName:  req.user?.fullName   || 'Customer',
            customerEmail: req.user?.email      || 'noreply@findernate.com',
            customerPhone: req.user?.phoneNumber || '9999999999',
            orderNote:     `Payment for ${checkout.productName}`,
            returnUrl:     `${frontendUrl}/payment/success?txnId=${cashfreeOrderId}&orderId=${order._id}&msgId=${messageId}`,
            notifyUrl:     `${backendUrl}/api/v1/payments/webhook`, // escrow webhook — NOT /cashfree/webhook (store only)
            expiryMinutes: 20
        });
    } catch (cfError) {
        await Order.findByIdAndDelete(order._id);
        const errorMsg = cfError?.response?.data?.message || cfError?.message || "Failed to create payment order";
        throw new ApiError(400, errorMsg);
    }

    const paymentSessionId = cfOrder?.payment_session_id;
    if (!paymentSessionId) {
        await Order.findByIdAndDelete(order._id);
        throw new ApiError(400, "Failed to get payment session from Cashfree");
    }

    order.cashfreeOrderId = cashfreeOrderId;
    await order.save();

    paymentLink.orderId = order._id;
    await paymentLink.save();

    const checkoutUrl = buildCashfreeCheckoutUrl(paymentSessionId);

    return res.status(200).json(
        new ApiResponse(200, {
            cashfreeOrderId,
            checkoutUrl,
            paymentSessionId,
            cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
            orderId: order._id,
            orderNumber: order.orderNumber,
            checkoutMessageId: messageId,
            productDetails: {
                name: checkout.productName,
                image: checkout.productImages?.[0] || '',
                totalPrice: checkout.totalPrice
            },
            seller: {
                name: checkout.sellerName,
                username: checkout.sellerUsername
            }
        }, "Cashfree payment initiated - proceed to payment")
    );
});

// Verify checkout payment & update message status
export const verifyCheckoutPayment = asyncHandler(async (req, res) => {
    const { txnId, cashfreeOrderId: cfIdBody, orderId, checkoutMessageId } = req.body;
    const cashfreeOrderId = cfIdBody || txnId;

    if (!cashfreeOrderId || !orderId) {
        throw new ApiError(400, "txnId (cashfreeOrderId) and orderId are required");
    }

    const order = await Order.findById(orderId);
    if (!order) {
        throw new ApiError(404, "Order not found");
    }

    // This endpoint settles whichever order the body names, so it must confirm the
    // caller is that order's buyer. Without it any authenticated user could settle
    // a stranger's pending order — including a guest order, which has no buyer at
    // all and must never be settled through this chat-checkout path.
    if (!order.buyerId || order.buyerId.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "This order does not belong to you");
    }

    if (order.paymentStatus === 'held' || order.paymentStatus === 'released') {
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: order._id,
                    orderNumber: order.orderNumber,
                    orderStatus: order.orderStatus,
                    paymentStatus: toUserPaymentStatus(order.paymentStatus),
                    amount: order.amount,
                    productDetails: order.productDetails
                },
                checkoutStatus: 'paid',
                message: "Payment already verified!"
            }, "Payment already verified")
        );
    }

    let cfOrder;
    try {
        cfOrder = await getCashfreeOrderStatus(cashfreeOrderId);
    } catch {
        throw new ApiError(400, "Failed to fetch order status from Cashfree");
    }

    // Third settlement path — same binding as /payments/verify and /payments/store/verify.
    // The transaction id arrives in the request body, so without this a caller could
    // quote one genuine cheap PAID transaction of their own against an expensive
    // pending order: it would flip to 'held' and escrow would be credited the full
    // order amount with no money behind it.
    assertTransactionBelongsToOrder(cfOrder, order);

    if (cfOrder?.order_status !== 'PAID') {
        order.paymentStatus = 'failed';
        order.orderStatus = 'payment_pending';
        await order.save();
        throw new ApiError(400, `Payment not completed. Status: ${cfOrder?.order_status || 'unknown'}`);
    }

    let cfPaymentId = null;
    try {
        const payments = await getCashfreePayments(cashfreeOrderId);
        const paid = payments?.find?.(p => p.payment_status === 'SUCCESS');
        cfPaymentId = paid?.cf_payment_id?.toString() || null;
    } catch { /* non-critical */ }

    // Atomic guard: only one of verifyCheckoutPayment / webhook wins.
    // cashfreeOrderId is deliberately NOT written here — it is set at order creation
    // and is the value just validated against. Rewriting it from a request body would
    // re-aim this order, and the refund paths that read that field, at a transaction
    // of the caller's choosing.
    const activeOrder = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
            cashfreePaymentId: cfPaymentId,
            paymentStatus: 'held',
            orderStatus: 'payment_received'
        },
        { new: true }
    );

    if (!activeOrder) {
        // Webhook already processed — re-fetch and return
        const refreshed = await Order.findById(order._id);
        return res.status(200).json(
            new ApiResponse(200, {
                order: {
                    _id: refreshed._id,
                    orderNumber: refreshed.orderNumber,
                    orderStatus: refreshed.orderStatus,
                    paymentStatus: toUserPaymentStatus(refreshed.paymentStatus),
                    amount: refreshed.amount,
                    productDetails: refreshed.productDetails
                },
                checkoutStatus: 'paid',
                message: "Payment already verified!"
            }, "Payment already verified")
        );
    }

    await PaymentLink.findByIdAndUpdate(
        activeOrder.paymentLinkId,
        { status: 'paid', paidAt: new Date() }
    );
    const escrowWallet = await EscrowWallet.getWallet();
    await escrowWallet.holdFunds(activeOrder, activeOrder.amount, `Payment for order ${activeOrder.orderNumber}`);

    let populatedConfirm;
    if (checkoutMessageId) {
        const checkoutMessage = await Message.findById(checkoutMessageId);
        if (checkoutMessage && checkoutMessage.checkoutDetails) {
            checkoutMessage.checkoutDetails.checkoutStatus = 'paid';
            await checkoutMessage.save();

            const confirmationText = `✅ Payment Confirmed!\n\nOrder: #${activeOrder.orderNumber}\nAmount: ₹${activeOrder.amount.toLocaleString('en-IN')}\nProduct: ${checkoutMessage.checkoutDetails.productName}\n\n. Seller will be notified to ship your order.`;

            const recipients = [];
            const chat = await Chat.findById(checkoutMessage.chatId);
            if (chat) {
                chat.participants.forEach(p => {
                    if (p.toString() !== activeOrder.buyerId.toString()) recipients.push(p);
                });
            }

            const confirmMsg = await Message.create({
                chatId: checkoutMessage.chatId,
                sender: activeOrder.buyerId,
                message: confirmationText,
                messageType: 'text',
                timestamp: new Date(),
                readBy: [activeOrder.buyerId],
                deliveryStatus: recipients.map(recipientId => ({
                    userId: recipientId,
                    status: 'sent',
                    deliveredAt: null,
                    seenAt: null
                }))
            });

            if (chat) {
                chat.lastMessageAt = new Date();
                chat.lastMessage = {
                    sender: activeOrder.buyerId,
                    message: `✅ Payment confirmed for #${activeOrder.orderNumber}`,
                    timestamp: new Date()
                };
                chat.lastMessageId = confirmMsg._id;
                await chat.save();
            }

            populatedConfirm = { _id: confirmMsg._id, chatId: confirmMsg.chatId };
        }
    }

    // Emit socket events
    if (checkoutMessageId && populatedConfirm) {
        const checkoutMessage = await Message.findById(checkoutMessageId);
        if (checkoutMessage) {
            const fullConfirm = await Message.findById(populatedConfirm._id)
                .populate('sender', 'username fullName profileImageUrl')
                .lean();

            if (fullConfirm) {
                safeEmitToChat(checkoutMessage.chatId.toString(), 'new_message', {
                    chatId: checkoutMessage.chatId,
                    message: fullConfirm
                });
            }

            safeEmitToUser(activeOrder.sellerId.toString(), 'checkout_paid', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                orderId: activeOrder._id,
                orderNumber: activeOrder.orderNumber,
                amount: activeOrder.amount
            });

            safeEmitToUser(activeOrder.buyerId.toString(), 'checkout_status_updated', {
                chatId: checkoutMessage.chatId,
                messageId: checkoutMessageId,
                checkoutStatus: 'paid',
                orderId: activeOrder._id,
                orderNumber: activeOrder.orderNumber
            });
        }
    }

    return res.status(200).json(
        new ApiResponse(200, {
            order: {
                _id: activeOrder._id,
                orderNumber: activeOrder.orderNumber,
                orderStatus: activeOrder.orderStatus,
                paymentStatus: toUserPaymentStatus(activeOrder.paymentStatus),
                amount: activeOrder.amount,
                productDetails: activeOrder.productDetails
            },
            checkoutStatus: 'paid',
            message: "Payment verified! Your order has been confirmed."
        }, "Checkout payment verified")
    );
});
