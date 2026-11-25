import mongoose from "mongoose";
import crypto from "crypto";
import {
    generateCashfreeRefundId,
    createCashfreeRefund,
} from "../config/cashfree.config.js";
import { ApiError } from "./ApiError.js";
import Order from "../models/order.models.js";
import EscrowWallet from "../models/escrowWallet.models.js";
import Notification from "../models/notification.models.js";
import { AuthOtp } from "../models/authOtp.models.js";
import { User } from "../models/user.models.js";
import { resolveOrCreateGuestBuyer } from "../controllers/user/guestAccount.js";
import { canonicalIdentifier, OTP_EXPIRY_MS } from "../controllers/user/_helpers.js";
import { sendEmail } from "./sendEmail.js";
import {
    renderEmail,
    renderOtpEmail,
    emailParagraph,
    emailButton,
    emailDetails,
    emailCallout,
    // Was missing: the account-ready email below uses it for the one-time
    // code, so building that email threw and the email was never sent (the
    // error is swallowed there, the SMS being the main channel).
    emailCodeBlock,
} from "./emailTemplate.js";
import { sendSms } from "./sendSms.js";

// ─────────────────────────────────────────────────────────────────────────────
// GUEST CHECKOUT — shared by BOTH public checkouts
//
//   • shareable payment links   POST /payments/post/create-order
//                               (payments.controllers.js)
//   • the online store          POST /payments/store/create-order
//                               (cashfree.payment.controller.js)
//
// A guest can create an order without an account. The account is created only
// once the payment is CONFIRMED, so an abandoned checkout leaves no orphan
// identity, and it is NEVER created for an email that already belongs to
// someone — that would be an account takeover by typed email address.
//
// Nothing on this path issues a session token. The buyer reaches the new
// account through the existing public reset-OTP pair
// (/users/send-reset-otp + /users/reset-password).
//
// WHY THIS IS A SHARED MODULE AND NOT A COPY IN EACH CONTROLLER.
// The two checkouts settle in different files, and for a long time only the
// shareable one back-filled a buyer: a store guest paid, the order settled to
// paymentStatus 'paid' with buyerId:null, and it stayed ownerless forever — no
// order history, no confirm-delivery, no dispute, no invoice, while the money
// sat in escrow. The fix is the SAME pipeline in both places, which only stays
// true if there is exactly one implementation of it. Account creation and the
// auto-refund in particular must never exist twice: two copies of "who owns
// this money" is how one of them silently stops matching reality.
//
// Everything here is written to be called from a payment confirmation. Nothing
// throws into one (the validators at the top are the exception — they run at
// order creation, before any money has moved).
// ─────────────────────────────────────────────────────────────────────────────

const getFrontendUrl = () => process.env.FRONTEND_URL || 'https://findernate.com';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Validators, run at ORDER CREATION ────────────────────────────────────────

// Both endpoints used to write req.body straight into the Order, so a partial
// address produced a PAID, unshippable order.
export const assertCompleteShippingAddress = (shippingAddress) => {
    if (
        !shippingAddress?.fullName      ||
        !shippingAddress?.phoneNumber   ||
        !shippingAddress?.addressLine1  ||
        !shippingAddress?.city          ||
        !shippingAddress?.state         ||
        !shippingAddress?.postalCode
    ) {
        throw new ApiError(400, "Complete shipping address is required");
    }
};

// What a guest must supply before an order is created for them. The age gate is
// an explicit attestation checkbox — no synthetic date of birth is invented.
//
// ONE definition for both checkouts. The store had a verbatim copy of this and
// the shareable flow had the original; identical today is not identical after
// the next edit, and this is the gate that makes the 13+ attestation and the
// terms acceptance legally defensible.
export const assertGuestBuyerDetails = (buyerDetails) => {
    if (!buyerDetails?.fullName || !buyerDetails?.email || !buyerDetails?.phoneNumber) {
        throw new ApiError(400, "Name, email and phone number are required to check out as a guest");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(buyerDetails.email).trim())) {
        throw new ApiError(400, "Please enter a valid email address");
    }
    if (buyerDetails.ageAttested !== true) {
        throw new ApiError(400, "You must confirm that you are 13 or older to continue");
    }
    if (buyerDetails.acceptedTerms !== true) {
        throw new ApiError(400, "You must accept the Terms of Use and Privacy Policy to continue");
    }
};

// EXISTING EMAIL = HARD STOP, checked BEFORE any order exists.
// Case-insensitive because the unique index is byte-wise: "Foo@Gmail.com" and
// "foo@gmail.com" are two different keys to it, and registration inserted
// through the raw driver for a long time, so stored case is not uniform.
// guestAccount.js repeats this check at payment time — this one is what diverts
// the buyer to sign in before they have paid anything.
//
// Returns the NORMALISED (trimmed, lowercased) address, which is what must be
// stored: every later lookup goes through Mongoose, which lowercases its
// filters, so a mixed-case address written verbatim is invisible to the
// refund/notification paths that have to reach this buyer.
//
// Call it AFTER the post and price have been resolved. The 409 it throws is an
// account-existence oracle, so a probe must cost a real product at a real
// price — which is also what makes the per-IP checkout limiter meaningful.
export const assertGuestEmailUnclaimed = async (email) => {
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({
        email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i')
    }).select('_id');

    if (existing) {
        throw new ApiError(409,
            "An account already exists for this email address. Please sign in to complete your purchase.",
            [{ field: "email", message: "Email already registered", action: "sign_in" }]
        );
    }
    return normalizedEmail;
};

/**
 * Writes the LEGAL EVIDENCE for the 13+ attestation and the terms acceptance a
 * guest just ticked. The consent captured on the checkout form has to survive
 * until the payment is confirmed, because that is when the account is created
 * and the permanent record is written from it.
 *
 * Stored through the RAW DRIVER: guestConsent is not a schema path on
 * OrderSchema and Mongoose's strict mode would drop it silently. Read it back
 * with .lean() or the raw collection (backfillGuestBuyer does).
 *
 * `req` is used for req.ip ONLY — NOT clientIp(req). clientIp() returns the
 * LEFTMOST x-forwarded-for entry, which is whatever the caller typed, so a
 * request carrying "X-Forwarded-For: 8.8.8.8" produced a consent record
 * permanently attributing the attestation to that address. req.ip is resolved
 * by express through the `trust proxy` setting in app.js and is the address our
 * own proxy actually observed. This value is copied into
 * legalAcceptance.acceptanceIP, AcceptanceLog.ipAddress and
 * guestAgeAttestation.ip when the account is created.
 */
export const recordGuestConsent = async (orderId, buyerDetails, req, source) => {
    await Order.collection.updateOne(
        { _id: orderId },
        {
            $set: {
                guestConsent: {
                    ageAttested:   buyerDetails?.ageAttested === true,
                    acceptedTerms: buyerDetails?.acceptedTerms === true,
                    minimumAge:    13,
                    attestedAt:    new Date(),
                    ip:            req?.ip || null,
                    userAgent:     req?.headers?.['user-agent'] || null,
                    source
                }
            }
        }
    );
};

// Where a guest consent record came from. Two values, one per public checkout.
export const GUEST_CONSENT_SOURCE = {
    SHAREABLE_LINK: 'guest_checkout_shareable_link',
    ONLINE_STORE:   'guest_checkout_online_store',
};

// ── Settlement ───────────────────────────────────────────────────────────────

// Delivers the "set your password" claim for a freshly created guest account.
// SMS is primary, email is a best-effort backup, and NEITHER failing may fail
// the payment — the money has already moved by the time this runs.
//
// The SMS utility is the Fast2SMS DLT sender used for every OTP in this
// codebase, and a DLT route can only carry pre-approved templates — a free-text
// "here is your link" SMS would simply be rejected. So the claim is delivered
// as a real password-reset OTP filed under the account's canonical identifier:
// the buyer types it on the reset page and chooses their own password. One
// record per channel, so entering either the phone or the email resolves.
const sendGuestClaimLink = async ({ user, orderNumber }) => {
    const frontendUrl = getFrontendUrl();
    const claimUrl = `${frontendUrl}/forgot-password`;
    const result = { sms: { sent: false }, email: { sent: false }, claimUrl };

    // crypto.randomInt, never Math.random. This code is the SOLE means of
    // taking control of a freshly minted account — whoever holds it chooses the
    // password — and V8's Math.random is a non-cryptographic PRNG whose
    // internal state can be recovered from a handful of observed outputs, which
    // would make the next buyer's claim code predictable. Same generator the
    // username suggestions already use.
    const plainOtp = crypto.randomInt(100000, 1000000).toString();
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);
    const expiryMinutes = Math.round(OTP_EXPIRY_MS / 60000);

    // Deliberately does NOT go through rateCheckAndUpsertOtp: that limiter is
    // sized for a person hammering "resend", whereas this fires once per
    // created account immediately after a settled payment — it is rate-limited
    // by money. Consuming the buyer's daily OTP quota here would lock them out
    // of the reset page they are being sent to.
    const upsertOtp = async (identifier, type) => {
        const hashedOtp = await AuthOtp.hashOtp(plainOtp);
        await AuthOtp.findOneAndUpdate(
            { identifier, type, purpose: "password_reset" },
            {
                otp: hashedOtp,
                expiry,
                sendCount: 1,
                windowStart: new Date(),
                retryAfter: new Date(Date.now() + 60 * 1000),
                attemptCount: 0,
                lockedUntil: null,
            },
            { upsert: true, new: true }
        );
    };

    // ── SMS (primary) ────────────────────────────────────────────────────────
    if (user.phoneNumber) {
        try {
            await upsertOtp(canonicalIdentifier(user, 'phone'), 'phone');
            await sendSms({
                phone: String(user.phoneNumber),
                otp: plainOtp,
                request_type: 'password_reset'
            });
            result.sms.sent = true;
        } catch (err) {
            // The ONE caller of sendSms that must swallow its throw, including
            // the "non-Indian number" ApiError. Everywhere else that error has
            // to reach the user, because the OTP is the only way forward; here
            // the email below carries the same code, and the payment has
            // already settled — turning an undeliverable SMS into a failure
            // would strand a paid order over a channel that was never required.
            result.sms.error = err?.message || 'SMS send failed';
            console.error(`[guest-claim] SMS failed for order ${orderNumber}:`, result.sms.error);
        }
    }

    // ── Email (best-effort backup) ───────────────────────────────────────────
    try {
        await upsertOtp(canonicalIdentifier(user, 'email'), 'email');
        const claimTitle = 'Your FinderNate account is ready';
        const claimBody =
            emailParagraph(`We created an account for you so you can track order #${orderNumber}.`, { topGap: 0 })
            + emailCodeBlock(plainOtp)
            + emailParagraph(`This code is valid for ${expiryMinutes} minutes. If it expires, use "Forgot password" on the same page.`, { muted: true })
            + emailButton({ label: 'Set your password', url: claimUrl })
            // The URL is repeated as visible text on purpose: some clients strip
            // the button, and a payment-related button whose destination cannot
            // be read is indistinguishable from a phishing button.
            + emailParagraph(`Or open this link: ${claimUrl}`, { muted: true })
            + emailDetails([
                ['Sign in with', user.email],
                ['Your username', user.username],
                ['Order', `#${orderNumber}`],
            ]);

        const claimText = [
            claimTitle, '',
            `We created an account for you so you can track order #${orderNumber}.`, '',
            `Your code: ${plainOtp}`,
            `Valid for ${expiryMinutes} minutes. If it expires, use "Forgot password" on the same page.`, '',
            `Set your password: ${claimUrl}`, '',
            `Sign in with: ${user.email}`,
            `Your username: ${user.username}`,
            `Order: #${orderNumber}`, '',
            '--', 'findernate.com',
        ].join('\n');

        const emailResult = await sendEmail({
            to: user.email,
            subject: "Set your password - FinderNate",
            html: renderEmail({
                title: claimTitle,
                preheader: `Your account for order #${orderNumber} is ready — set a password to track it.`,
                bodyHtml: claimBody,
            }),
            text: claimText,
        });
        result.email = { ...emailResult, sent: !!emailResult?.success };
        if (!emailResult?.success) {
            console.error(`[guest-claim] Email failed for order ${orderNumber}:`, emailResult?.error);
        }
    } catch (err) {
        result.email.error = err?.message || 'Email send failed';
        console.error(`[guest-claim] Email threw for order ${orderNumber}:`, result.email.error);
    }

    return result;
};

/**
 * The escrow ledger copies `order.buyerId` into the transaction row at write
 * time, and for a guest order the hold is recorded before the buyer exists — so
 * every guest hold landed in the ledger with buyerId:null and stayed that way.
 * Back-fills those rows once the buyer is known.
 *
 * Best effort by design: the ledger row is a reporting artefact, and failing to
 * patch it must never fail a completed payment.
 */
const patchEscrowLedgerBuyer = async (orderId, buyerId) => {
    try {
        const orderObjectId = typeof orderId === 'string'
            ? new mongoose.Types.ObjectId(orderId)
            : orderId;

        await EscrowWallet.updateMany(
            { 'transactions.orderId': orderObjectId },
            { $set: { 'transactions.$[t].buyerId': buyerId } },
            { arrayFilters: [{ 't.orderId': orderObjectId, 't.buyerId': null }] }
        );
    } catch (err) {
        console.error('[guest-checkout] Escrow ledger buyer back-fill failed:', err?.message);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// COLLISION AT SETTLE → AUTOMATIC REFUND (never a claimable orphan)
//
// The existing-email check runs BEFORE the buyer pays, so this only happens when
// the address stops being free DURING the ~20-minute payment window — the buyer
// registers in another tab, or a sibling guest checkout for the same address
// settles first. It is rare, and the handling here is deliberately small.
//
// WHY THERE IS NO "CLAIM YOUR ORDER" ENDPOINT ANY MORE.
// The previous pass parked these orders at guestClaim.status =
// 'claimable_existing_account' and shipped POST /orders/:orderId/claim, which
// attached the order to whichever signed-in account's `email` field matched.
// That endpoint WAS the takeover it was written to prevent: registration in this
// codebase verifies the PHONE only — auth.js verifyRegistrationOTP sets
// isPhoneVerified:true and never touches isEmailVerified, which stays at its
// schema default of false — so `user.email` is an UNPROVEN string. Anyone who
// learned the email on a guest order could register that address against their
// own phone, claim the paid order, confirm delivery, and have the escrow
// released for goods that were never shipped, with the real buyer locked out
// permanently. Requiring isEmailVerified === true would not have saved it
// either: that flag is false for essentially every account on the platform,
// including the ones guest checkout itself creates, so the endpoint would have
// been dead code still carrying the risk.
//
// So the money goes back instead. Cashfree refunds are already wired up and
// proven on the admin path (adminEscrow.controllers.js manualRefundPayment uses
// createCashfreeRefund), so an automated refund is genuinely available here —
// no human needed for the common case, and nothing ownerless is ever left
// behind for a future endpoint to "rescue".
// ─────────────────────────────────────────────────────────────────────────────

// The states in which there is money to send back. 'held' is the shareable/chat
// escrow path; 'paid' is the online store, which banks straight to 'paid'.
const GUEST_REFUNDABLE_PAYMENT_STATUSES = ['held', 'paid'];

// Tells the two affected parties what happened. Best effort throughout: the
// refund has already been requested by the time this runs, and a failed email
// must never turn into a retry of the refund.
//
// The buyer is reached by EMAIL only. sendSms() is the Fast2SMS DLT sender, and
// a DLT route can only carry pre-approved templates — a free-text "we refunded
// you" SMS would simply be rejected by the carrier, so pretending to send one
// would be worse than not sending it.
const notifyGuestOrderRefunded = async ({ order, email }) => {
    const amountText = `₹${Number(order.amount).toFixed(2)}`;

    if (email) {
        try {
            const productName = order.productDetails?.name || 'your order';
            const refundTitle = 'We have refunded your payment';
            const refundBody =
                emailParagraph(`Your payment for order #${order.orderNumber} has been refunded to the payment method you used.`, { topGap: 0 })
                // The product name is seller-supplied free text and was
                // previously interpolated raw; emailDetails escapes it.
                + emailDetails([
                    ['Refunded', amountText],
                    ['Order', `#${order.orderNumber}`],
                    ['Item', productName],
                ])
                + emailParagraph('This email address already has a FinderNate account, so we could not create a new one to hold the order — and we will never attach a paid order to an existing account without you signing in. Rather than leave your money sitting with us, we sent it straight back.')
                + emailParagraph('Refunds normally reach your account within 5-7 business days.', { muted: true })
                + emailParagraph('To buy this item, sign in with this email address first and check out again — your order will then be tracked on your account.');

            const refundText = [
                refundTitle, '',
                `Your payment for order #${order.orderNumber} has been refunded to the payment method you used.`, '',
                `Refunded: ${amountText}`,
                `Order: #${order.orderNumber}`,
                `Item: ${productName}`, '',
                'This email address already has a FinderNate account, so we could not create a new one to hold the order — and we will never attach a paid order to an existing account without you signing in. Rather than leave your money sitting with us, we sent it straight back.', '',
                'Refunds normally reach your account within 5-7 business days.', '',
                'To buy this item, sign in with this email address first and check out again — your order will then be tracked on your account.', '',
                '--', 'findernate.com',
            ].join('\n');

            await sendEmail({
                to: email,
                subject: `Refund issued for order #${order.orderNumber} - FinderNate`,
                html: renderEmail({
                    title: refundTitle,
                    preheader: `${amountText} for order #${order.orderNumber} has been sent back to your payment method.`,
                    bodyHtml: refundBody,
                }),
                text: refundText,
            });
        } catch (err) {
            console.error(`[guest-refund] Buyer email failed for order ${order.orderNumber}:`, err?.message);
        }
    }

    try {
        await Notification.create({
            receiverId: order.sellerId,
            type: 'order',
            orderId: order._id,
            message: `Order #${order.orderNumber} was cancelled and refunded automatically — the guest buyer's email already belonged to an existing account, so the order could not be linked to a buyer. Do not ship it.`
        });
    } catch (err) {
        console.error(`[guest-refund] Seller notification failed for order ${order.orderNumber}:`, err?.message);
    }
};

// The refund could not be made. Money is still ours to move, so hand it to the
// existing admin escrow tooling (POST /admin/escrow/orders/:orderId/refund)
// with a status the admin screens can see, rather than inventing a second
// self-service path to the same funds.
const flagGuestOrderForAdmin = async (order, reason) => {
    const now = new Date();
    console.error(`[guest-refund] MANUAL REFUND REQUIRED for order ${order.orderNumber} (${order._id}): ${reason}`);

    try {
        await Order.updateOne(
            { _id: order._id },
            {
                $set: {
                    'guestSettlement.status': 'refund_failed_admin_review',
                    'guestSettlement.error': String(reason).slice(0, 500),
                    'guestSettlement.flaggedAt': now
                },
                $push: {
                    statusHistory: {
                        status: 'guest_order_refund_failed_admin_review',
                        timestamp: now,
                        note: 'Guest order has no buyer and could not be auto-refunded. Refund it from the admin escrow tools.'
                    }
                }
            }
        );
    } catch (err) {
        console.error(`[guest-refund] Could not flag order ${order.orderNumber} for admin:`, err?.message);
    }

    const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.SUPPORT_EMAIL;
    if (!adminEmail) return;
    try {
        const alertTitle = 'A guest order needs a manual refund';
        const alertAmount = `₹${Number(order.amount).toFixed(2)}`;
        // Warning tone, not the usual gold: this is the only email that asks a
        // human to go and do something, and it must not read as one more
        // transactional notice in a busy inbox. `reason` is an internal error
        // string — escaped like everything else, since it can carry anything a
        // gateway or a stack trace put in it.
        const alertBody =
            emailParagraph(`Order #${order.orderNumber} settled with no buyer account, and the automatic refund did not go through. The money is still with us.`, { topGap: 0 })
            + emailCallout(`Reason: ${String(reason)}`, { tone: 'warning' })
            + emailDetails([
                ['Order number', String(order.orderNumber)],
                ['Order id', String(order._id)],
                ['Amount to refund', alertAmount],
            ])
            + emailParagraph('Refund it from the admin escrow screen.');

        const alertText = [
            alertTitle, '',
            `Order #${order.orderNumber} settled with no buyer account, and the automatic refund did not go through. The money is still with us.`, '',
            `Reason: ${String(reason)}`, '',
            `Order number: ${order.orderNumber}`,
            `Order id: ${order._id}`,
            `Amount to refund: ${alertAmount}`, '',
            'Refund it from the admin escrow screen.',
        ].join('\n');

        await sendEmail({
            to: adminEmail,
            subject: `[Action required] Guest order ${order.orderNumber} needs a manual refund`,
            html: renderEmail({
                title: alertTitle,
                preheader: `${alertAmount} is stuck on order #${order.orderNumber} and needs a manual refund.`,
                bodyHtml: alertBody,
            }),
            text: alertText,
        });
    } catch (err) {
        console.error('[guest-refund] Admin alert email failed:', err?.message);
    }
};

/**
 * Refunds a paid guest order that could not be given a buyer.
 *
 * Must be called AFTER the escrow entry has been written (holdFunds on the
 * shareable path, creditPayment on the store path — both increment
 * heldBalance), so the ledger can be unwound in the same order it was built.
 *
 * Idempotent: the transition out of 'auto_refund_pending' is a conditional
 * update, so of the confirmations that race here (verify + webhook, both of
 * which run the back-fill) exactly one performs the refund.
 */
const refundOrphanedGuestOrder = async (orderId) => {
    try {
        const now = new Date();

        // Claim the work. Conditional on the order still being unattached, still
        // holding money, and still pending a refund.
        const claimed = await Order.findOneAndUpdate(
            {
                _id: orderId,
                buyerId: null,                       // also matches a missing field
                paymentStatus: { $in: GUEST_REFUNDABLE_PAYMENT_STATUSES },
                'guestSettlement.status': 'auto_refund_pending'
            },
            {
                $set: {
                    'guestSettlement.status': 'auto_refund_in_progress',
                    'guestSettlement.startedAt': now
                }
            },
            { new: true }
        );

        // Lost the race, already refunded, or a buyer got attached after all.
        if (!claimed) return;

        if (!claimed.cashfreeOrderId) {
            await flagGuestOrderForAdmin(claimed, 'Order has no cashfreeOrderId, so no refund can be addressed');
            return;
        }

        const refundId = claimed.refundId || generateCashfreeRefundId();
        let refundStatus = null;

        try {
            const cfRefund = await createCashfreeRefund(
                claimed.cashfreeOrderId,
                refundId,
                claimed.amount,
                `Automatic refund - guest order ${claimed.orderNumber} could not be linked to a buyer account`
            );
            refundStatus = cfRefund?.refund_status || null;
        } catch (err) {
            await flagGuestOrderForAdmin(claimed, `Cashfree refund creation failed: ${err?.message || err}`);
            return;
        }

        // PENDING is a success from our side: Cashfree has accepted the refund
        // and will settle it. Anything else means the money did not move.
        if (refundStatus !== 'SUCCESS' && refundStatus !== 'PENDING') {
            await flagGuestOrderForAdmin(claimed, `Cashfree refund in unexpected state: ${refundStatus}`);
            return;
        }

        const refundedAt = new Date();
        await Order.updateOne(
            { _id: claimed._id },
            {
                $set: {
                    refundId,
                    paymentStatus: 'refunded',
                    orderStatus: 'refunded',
                    'guestSettlement.status': 'auto_refunded',
                    'guestSettlement.refundId': refundId,
                    'guestSettlement.refundStatus': refundStatus,
                    'guestSettlement.refundedAt': refundedAt
                },
                $push: {
                    statusHistory: {
                        status: 'guest_order_auto_refunded',
                        timestamp: refundedAt,
                        note: 'Guest email already belonged to an existing account at settlement, so the order could not be linked to a buyer. Payment refunded automatically.'
                    }
                }
            }
        );

        // Unwind the escrow entry. Separately guarded: the money has already been
        // sent back at this point, and a ledger write that fails must not look
        // like a refund that failed. refundFunds() throws when the hold is not
        // there (e.g. a flow that never held), which is not an error worth
        // escalating — the reporting row is behind, the cash is not.
        try {
            const wallet = await EscrowWallet.getWallet();
            await wallet.refundFunds(
                claimed,
                claimed.amount,
                `Automatic refund - unattachable guest order ${claimed.orderNumber}`
            );
        } catch (err) {
            console.error(`[guest-refund] Escrow ledger unwind failed for order ${claimed.orderNumber}:`, err?.message);
        }

        await notifyGuestOrderRefunded({ order: claimed, email: claimed.buyerDetails?.email || null });
    } catch (err) {
        // Never throw into a payment confirmation: the buyer must not see
        // "Payment Failed" because a refund routine tripped.
        console.error('[guest-refund] Auto-refund failed:', err?.message, err);
    }
};

// Creates the buyer's account once a guest order is CONFIRMED paid and attaches
// it to the order. Called from every settlement point of both public checkouts.
//
// IDEMPOTENT BY CONSTRUCTION. The Cashfree webhook can fire more than once and
// can race the verify call, so:
//   - buyerId is set with an atomic conditional update that only matches while
//     it is still null; a second execution modifies nothing and returns.
//   - WINNING THAT UPDATE — not "having created the user" — is what authorises
//     the claim message. Those two are independent: with a fast UPI payment the
//     webhook and the browser's verify call overlap routinely, and the
//     execution that loses the user insert can still win the order update. The
//     old code sent the claim only when its own call had created the user, so
//     in that ordering the insert-winner returned early (it lost the order
//     update) and the update-winner sent nothing — the account existed, the
//     order was attached, and the buyer was never told either fact. The send is
//     now gated on modifiedCount === 1, and the same conditional update stamps
//     guestAccount.claimSentAt, so no retry can send a second code.
// It NEVER throws: a failure here must not turn a completed payment into a
// "Payment Failed" screen.
//
// Returns a summary for the HTTP response (see describeGuestAccount below);
// callers may ignore it.
const backfillGuestBuyer = async (order) => {
    try {
        if (!order || order.buyerId) return;

        // The two PUBLIC checkouts only — both stamp isShareableOrder:true on
        // the orders they create. The chat/checkout flows always have an
        // authenticated buyer and never reach this; the shape is checked rather
        // than assumed because both settlement endpoints are public.
        if (!order.isShareableOrder) return;

        const details = order.buyerDetails;
        if (!details?.email) return;

        // guestConsent is written by recordGuestConsent through the raw driver
        // (order.models.js is outside the scope of this change), so read it the
        // same way — a hydrated Mongoose document drops unknown fields.
        const stored = await Order.collection.findOne(
            { _id: order._id },
            { projection: { buyerId: 1, guestConsent: 1 } }
        );
        if (stored?.buyerId) return; // another execution already attached a buyer

        const consent = stored?.guestConsent || {};

        const outcome = await resolveOrCreateGuestBuyer({
            email:         details.email,
            fullName:      details.fullName    || order.shippingAddress?.fullName,
            phoneNumber:   details.phoneNumber || order.shippingAddress?.phoneNumber,
            ageAttested:   consent.ageAttested === true,
            acceptedTerms: consent.acceptedTerms === true,
            ip:            consent.ip || null,
            userAgent:     consent.userAgent || null,
        });

        const now = new Date();

        // Two different ways this order can end up with no buyer, both handled the
        // same way: queue the refund. Money that has settled must always have a
        // route to either a buyer or a refund — never neither.
        //
        //   collision  — the email was free at checkout but belongs to someone by
        //                the time the payment settled. buyerId STAYS NULL; an order
        //                is never auto-attached to an account on the strength of a
        //                typed address.
        //   !user      — account creation exhausted its retries (repeated username
        //                or uid duplicate-key losses). Rare, but returning quietly
        //                here would leave a PAID order with no owner, no refund and
        //                nothing flagged for an admin — silent stuck money.
        const noBuyerReason = outcome.collision
            ? 'email_registered_during_payment_window'
            : (!outcome.user ? 'account_creation_failed' : null);

        if (noBuyerReason) {
            // Conditional on buyerId still being null so this cannot overwrite an
            // attach that just won a concurrent race.
            const flagged = await Order.updateOne(
                { _id: order._id, buyerId: null },
                {
                    $set: {
                        'guestSettlement.status': 'auto_refund_pending',
                        'guestSettlement.reason': noBuyerReason,
                        'guestSettlement.detectedAt': now
                    },
                    $push: {
                        statusHistory: {
                            status: 'guest_order_auto_refund_pending',
                            timestamp: now,
                            note: outcome.collision
                                ? 'Guest email belongs to an existing account — the order cannot be linked to a buyer, so the payment is being refunded.'
                                : 'An account could not be created for the guest buyer, so the order has no owner and the payment is being refunded.'
                        }
                    }
                }
            );

            // Only the execution that actually queued the refund reports it, so
            // the caller does not fire a second (harmless but pointless) attempt.
            return { orphaned: flagged.modifiedCount === 1 };
        }

        // ── The single point of truth for "this order now has a buyer" ───────
        // buyerId, the account marker the success page reads, and the
        // claim-was-sent flag all land in ONE conditional update, so whoever
        // wins it is unambiguously the one execution that owes the buyer a
        // claim message. guestSettlement is unset in the same breath: a racing
        // sibling can have queued an auto-refund moments earlier (it sees its
        // own duplicate-key loss as a collision), and an order that DOES have a
        // buyer must not be left carrying a pending-refund marker.
        const attached = await Order.collection.updateOne(
            { _id: order._id, buyerId: null },   // also matches a missing field
            {
                $set: {
                    buyerId: outcome.user._id,
                    guestAccount: {
                        status:      'created',
                        userId:      outcome.user._id,
                        username:    outcome.user.username,
                        email:       outcome.user.email,
                        createdAt:   now,
                        // Idempotency flag for the claim delivery below.
                        claimSentAt: now,
                    },
                    updatedAt: now
                },
                $unset: { guestSettlement: '' },
                $push: {
                    statusHistory: {
                        status: 'guest_account_created',
                        timestamp: now,
                        note: `Account created for the guest buyer and linked to this order (@${outcome.user.username}).`
                    }
                }
            }
        );

        // Someone else won the race — clean no-op, and no second claim message.
        if (attached.modifiedCount !== 1) return;

        // Keep the in-memory document in step with what was just written, so the
        // response the caller builds from it is not stale.
        order.buyerId = outcome.user._id;

        // The escrow entry can already have been written with buyerId:null (the
        // ledger copies the field at write time, and for a guest order the money
        // moves before the buyer exists). Now that there is a buyer, say so.
        await patchEscrowLedgerBuyer(order._id, outcome.user._id);

        // Fire and forget: a failed SMS or email must not hold up, or fail, the
        // payment response. Gated on WINNING THE ATTACH above, never on
        // `outcome.created`.
        sendGuestClaimLink({ user: outcome.user, orderNumber: order.orderNumber })
            .catch(err => console.error('[guest-claim] delivery error:', err?.message));
    } catch (err) {
        console.error('[guest-checkout] Buyer back-fill failed:', err?.message, err);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SUCCESS PAGE IS TOLD  (verifyPayment / verifyOnlineStorePayment)
//
// An account can be created for the buyer without the buyer ever finding out:
// the verify responses used to carry nothing but { order }, so the page had no
// way to say "we made you an account, here is your username, check your phone
// for the code". This is the shape the website reads. It is deliberately
// explicit about the three outcomes.
//
//   accountCreated: boolean
//   guestAccount: null                       // not a guest order
//     | {
//         status: 'created',                 // a NEW account exists
//         email, username,
//         claimLinkSent: boolean,            // set-password code dispatched
//         claimUrl,                          // where to enter it
//         message
//       }
//     | {
//         status: 'refunded',                // email already had an account, so
//         email, username: null,             // no account was made and the order
//         claimLinkSent: false,              // could not be linked to a buyer —
//         refunded: true,                    // the payment has been sent back
//         message
//       }
//     | { status: 'unavailable', … }
//
// There is NO 'claim this order' outcome. See refundOrphanedGuestOrder above for
// why a self-service claim is an account-takeover primitive on this codebase.
//
// NEVER carries a password or a token: the guest path issues neither.
// ─────────────────────────────────────────────────────────────────────────────
export const describeGuestAccount = async (order) => {
    const empty = { accountCreated: false, guestAccount: null };
    try {
        if (!order?.isShareableOrder || !order?.buyerDetails?.email) return empty;

        const frontendUrl = getFrontendUrl();
        const stored = await Order.collection.findOne(
            { _id: order._id },
            { projection: { guestAccount: 1, guestSettlement: 1, buyerId: 1 } }
        );

        const account = stored?.guestAccount;
        if (account?.status === 'created') {
            return {
                accountCreated: true,
                guestAccount: {
                    status:        'created',
                    email:         account.email,
                    username:      account.username,
                    claimLinkSent: !!account.claimSentAt,
                    claimUrl:      `${frontendUrl}/forgot-password`,
                    message:       "We created a Findernate account for you so you can track this order. " +
                                   "Check your phone and email for a code, then choose your password."
                }
            };
        }

        // The email turned out to belong to somebody by the time the payment
        // settled, so no account was created and the order has no buyer. It is
        // being — or has been — refunded. Told plainly, and NEVER as "sign in to
        // claim it": there is no claim, by design.
        const settlement = stored?.guestSettlement;
        if (settlement?.status && settlement.status !== 'refund_failed_admin_review') {
            const done = settlement.status === 'auto_refunded';
            return {
                accountCreated: false,
                guestAccount: {
                    status:        'refunded',
                    email:         order.buyerDetails.email,
                    username:      null,
                    claimLinkSent: false,
                    refunded:      done,
                    claimUrl:      `${frontendUrl}/signin`,
                    message:       "This email already has a Findernate account, so we could not create one to hold " +
                                   "this order. Your payment " + (done ? "has been refunded" : "is being refunded") +
                                   " to the method you paid with, and normally reaches you within 5-7 business days. " +
                                   "Sign in with this email and check out again to place the order on your account."
                }
            };
        }

        if (settlement?.status === 'refund_failed_admin_review') {
            return {
                accountCreated: false,
                guestAccount: {
                    status:        'refunded',
                    email:         order.buyerDetails.email,
                    username:      null,
                    claimLinkSent: false,
                    refunded:      false,
                    claimUrl:      `${frontendUrl}/signin`,
                    message:       "This email already has a Findernate account, so we could not create one to hold " +
                                   "this order. Our team is processing your refund and will be in touch."
                }
            };
        }

        // Paid, but no account and no marker — the rare path where creation
        // could not complete. Say so plainly rather than implying an account
        // the buyer does not have.
        return {
            accountCreated: false,
            guestAccount: {
                status:        'unavailable',
                email:         order.buyerDetails.email,
                username:      null,
                claimLinkSent: false,
                claimUrl:      `${frontendUrl}/signin`,
                message:       "Your payment is confirmed, but we could not set up an account automatically. " +
                               "Please contact support with your order number."
            }
        };
    } catch (err) {
        console.error('[guest-checkout] Account summary failed:', err?.message);
        return empty;
    }
};

/**
 * The whole settlement pipeline for ONE confirmed guest order, in the one order
 * these steps are correct in:
 *
 *   1. back-fill the buyer  — BEFORE the escrow entry, so the ledger row records
 *      the buyer instead of null (it copies order.buyerId at write time).
 *   2. write the escrow entry — the caller does this, in `writeEscrowEntry`,
 *      because the two flows record it differently (hold vs credit).
 *   3. auto-refund a collision — AFTER the escrow entry, because the refund
 *      unwinds the very entry step 2 wrote.
 *
 * Getting that order wrong is silent: refunding first debits a balance that
 * does not exist yet and then re-holds money that has already gone back. Both
 * flows call this rather than each open-coding the sequence.
 *
 * Returns { orphaned } — true only for the single execution that queued the
 * refund, so a racing sibling does not fire a second (harmless) attempt.
 *
 * This is the ONLY entry point: backfillGuestBuyer and refundOrphanedGuestOrder
 * are deliberately module-private, because calling either alone is a bug that
 * looks like working code.
 */
export const settleGuestOrder = async (order, writeEscrowEntry) => {
    const settled = await backfillGuestBuyer(order);

    if (writeEscrowEntry) await writeEscrowEntry();

    if (settled?.orphaned) await refundOrphanedGuestOrder(order._id);

    return { orphaned: settled?.orphaned === true };
};
