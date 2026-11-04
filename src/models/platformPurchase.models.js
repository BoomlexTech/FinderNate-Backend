import mongoose from 'mongoose';

/**
 * Payments to Findernate itself (Phase 4): ads (#27), the re-KYC fee (#74),
 * one-time listings (#80) and the plan for regular users (#77). One row per
 * attempt; `status` turns `paid` only after the gateway or Google Play has
 * confirmed it, and fulfilment runs once (`fulfilledAt`).
 */
const platformPurchaseSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['ad', 're_kyc', 'listing', 'plus'], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    description: String,
    amount: { type: Number, required: true },   // before GST
    gstPercent: { type: Number, default: 18 },
    gst: { type: Number, default: 0 },
    total: { type: Number, required: true },    // what was charged
    currency: { type: String, default: 'INR' },
    provider: { type: String, enum: ['cashfree', 'google_play', 'free'], required: true },
    cashfreeOrderId: { type: String, index: true, sparse: true },
    cashfreePaymentId: String,
    playProductId: String,
    playPurchaseToken: { type: String, index: true, sparse: true },
    playOrderId: String,
    status: { type: String, enum: ['created', 'paid', 'failed', 'refunded'], default: 'created', index: true },
    paidAt: Date,
    fulfilledAt: Date,
    invoiceNumber: String,
}, { timestamps: true });

platformPurchaseSchema.index({ kind: 1, refId: 1 });

export default mongoose.model('PlatformPurchase', platformPurchaseSchema);
