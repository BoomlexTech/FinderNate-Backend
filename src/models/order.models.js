import mongoose from "mongoose";

const ShippingAddressSchema = new mongoose.Schema({
    fullName: String,
    phoneNumber: String,
    addressLine1: String,
    addressLine2: String,
    city: String,
    state: String,
    postalCode: String,
    country: { type: String, default: 'India' }
}, { _id: false });

const ShippingInfoSchema = new mongoose.Schema({
    trackingId: String,
    carrier: String,
    shippedAt: Date,
    deliveredAt: Date,
    packingVideoUrl: String,
    packingImages: [String]
}, { _id: false });

const BuyerProofSchema = new mongoose.Schema({
    paymentScreenshot: String,
    openingVideoUrl: String,
    uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const DisputeSchema = new mongoose.Schema({
    reason: {
        type: String,
        enum: ['damaged_product', 'wrong_item', 'missing_item', 'not_as_described', 'defective', 'counterfeit', 'other'],
        required: true
    },
    description: String,
    evidence: [String],
    disputeVideoUrl: String,
    disputeVideoUploadedAt: Date,
    status: { type: String, enum: ['open', 'under_review', 'resolved', 'rejected'], default: 'open' },
    resolution: String,
    createdAt: { type: Date, default: Date.now },
    resolvedAt: Date
}, { _id: false });

const SellerResponseSchema = new mongoose.Schema({
    status: { type: String, enum: ['confirmed', 'rejected'] },
    rejectionReason: {
        type: String,
        enum: [
            'out_of_stock',
            'price_change',
            'invalid_address',
            'need_clarification',
            'certificate_required',
            'other'
        ]
    },
    rejectionNote: String,
    respondedAt: { type: Date, default: Date.now }
}, { _id: false });

// Guest buyer details schema (for shareable payment links)
const GuestBuyerDetailsSchema = new mongoose.Schema({
    fullName: String,
    email: String,
    phoneNumber: String
}, { _id: false });

// ─────────────────────────────────────────────────────────────────────────────
// WHAT HAPPENED TO A GUEST ORDER THAT COULD NOT BE GIVEN A BUYER
//
// A guest checkout only creates the buyer's account once the payment is
// CONFIRMED, and it refuses to create one for an address that already belongs to
// somebody. In the ~20-minute payment window that address can stop being free,
// and the order then settles with buyerId:null and no way for anyone to act on
// it — confirm-delivery, dispute and refund all go through isOrderBuyer, which
// needs a buyerId.
//
// There is deliberately NO "claim this order" path. The money is refunded
// automatically instead (utils/guestCheckout.utils.js → refundOrphanedGuestOrder) and
// this is the record of that. A REAL SCHEMA PATH, not a raw-driver field, so the
// admin escrow screens and every ordinary read can see it — a marker nothing can
// read is a marker that does not exist.
//
// It carries NO email address: the buyer's address already lives in
// buyerDetails, which is redacted out of every seller-facing read
// (order/helpers.js → redactOrderForViewer), and a second copy here would walk
// straight past that redaction.
const GuestSettlementSchema = new mongoose.Schema({
    status: {
        type: String,
        enum: [
            'auto_refund_pending',        // collision detected, refund not started
            'auto_refund_in_progress',    // one execution has claimed the refund
            'auto_refunded',              // Cashfree accepted the refund
            'refund_failed_admin_review'  // needs a human — see admin escrow tools
        ]
    },
    reason: String,
    refundId: String,
    refundStatus: String,
    error: String,
    detectedAt: Date,
    startedAt: Date,
    refundedAt: Date,
    flaggedAt: Date
}, { _id: false });

const OrderSchema = new mongoose.Schema({
    orderNumber: { type: String, required: true, unique: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Optional for guest checkout
    buyerDetails: GuestBuyerDetailsSchema, // For guest buyers via shareable links
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
    paymentLinkId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentLink' },
    productDetails: {
        name: String,
        description: String,
        price: { type: Number, required: true },
        quantity: { type: Number, default: 1 },
        images: [String],
        category: String
    },
    amount: { type: Number, required: true },
    shippingCharges: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    // Phase 4 #74: business-to-business orders (both sides verified
    // businesses) carry a 10% commission; others the normal platform fee.
    isB2B: { type: Boolean, default: false },
    commissionRate: { type: Number, default: undefined },
    commissionAmount: { type: Number, default: undefined },
    sellerNetAmount: { type: Number, default: undefined },
    sellerAmount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'held', 'released', 'refunded', 'failed'],
        default: 'pending'
    },
    orderStatus: {
        type: String,
        enum: ['created', 'payment_pending', 'payment_received', 'processing', 'shipped', 'delivered', 'confirmed', 'disputed', 'cancelled', 'refunded', 'seller_rejected'],
        default: 'created'
    },
    // ── LEGACY GATEWAY IDS — READ-ONLY HISTORY, DO NOT DELETE ─────────────────
    // The Razorpay and PhonePe integrations were removed; Cashfree is the only
    // gateway. Nothing WRITES these fields any more.
    //
    // They are deliberately kept in the schema rather than dropped. Removing a
    // path from a Mongoose schema does not delete the stored value — it makes it
    // invisible to the model, so every order paid before the migration would
    // silently lose its payment reference. These are the only receipt a buyer or
    // support has for those orders, and they are still read downstream:
    //   - controllers/invoice.controllers.js reads razorpayPaymentId/razorpayOrderId
    //     into the invoice detail payload.
    //   - the website's InvoiceModal renders order.phonePeTransactionId as
    //     "Payment ID" (frontend src/components/orders/InvoiceModal.tsx).
    // Delete these only after confirming in production that no Order document
    // still carries them.
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    phonePeMerchantTransactionId: String,
    phonePeTransactionId: String,
    // ── ACTIVE GATEWAY (Cashfree) ─────────────────────────────────────────────
    cashfreeOrderId: String,      // Cashfree order ID (CF-xxx) stored for webhook lookup
    cashfreePaymentId: String,    // Cashfree cf_payment_id populated after payment
    refundId: String,             // Cashfree refund ID once a refund is initiated
    shippingAddress: ShippingAddressSchema,
    shippingInfo: ShippingInfoSchema,
    buyerProof: BuyerProofSchema,
    dispute: DisputeSchema,
    sellerResponse: SellerResponseSchema,
    statusHistory: [{
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String
    }],
    deliveryConfirmedAt: Date,
    paymentReleasedAt: Date,
    buyerRating: { type: Number, min: 1, max: 5 },
    buyerReview: String,
    sellerRating: { type: Number, min: 1, max: 5 },
    sellerReview: String,
    isShareableOrder: { type: Boolean, default: false }, // Created via shareable payment link
    guestSettlement: GuestSettlementSchema
}, { timestamps: true });

OrderSchema.pre('save', function(next) {
    if (this.isModified('orderStatus') || this.isModified('paymentStatus')) {
        this.statusHistory.push({
            status: `${this.orderStatus} - ${this.paymentStatus}`,
            timestamp: new Date()
        });
    }
    next();
});

// Phase 4 #74: classify new orders as B2B (both sides verified businesses)
// and record the commission. Best-effort: a lookup failure leaves the order
// as a normal one rather than blocking the sale.
OrderSchema.pre('save', async function(next) {
    if (!this.isNew || this.commissionRate !== undefined) return next();
    try {
        const { classifyOrderCommission } = await import('../utils/b2b.utils.js');
        Object.assign(this, await classifyOrderCommission(this.buyerId, this.sellerId, this.amount));
    } catch (error) {
        console.warn('[b2b] commission classification skipped:', error?.message);
    }
    next();
});

OrderSchema.index({ buyerId: 1, createdAt: -1 });
OrderSchema.index({ sellerId: 1, createdAt: -1 });
OrderSchema.index({ isB2B: 1, createdAt: -1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ paymentStatus: 1 });
// Legacy. No webhook looks orders up by this any more (the Cashfree webhooks use
// cashfreeOrderId below). Kept because the index already exists in production —
// dropping the declaration would not drop it there, and it still serves manual
// lookups of pre-Cashfree orders. Drop it deliberately with a migration, if ever.
OrderSchema.index({ phonePeMerchantTransactionId: 1 });
OrderSchema.index({ cashfreeOrderId: 1 });              // fast Cashfree webhook lookup

export default mongoose.model('Order', OrderSchema);
