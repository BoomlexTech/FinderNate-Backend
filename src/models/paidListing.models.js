import mongoose from 'mongoose';

/**
 * One-time product post for regular users (Phase 4 #80):
 * Aadhaar check → listing checks → pay → visible to everyone for 30 or 60
 * days → expires. Renewal is a new row (pay and check again).
 */
const paidListingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    days: { type: Number, enum: [30, 60], required: true },
    amount: { type: Number, required: true },
    gstPercent: { type: Number, default: 18 },
    gst: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: {
        type: String,
        enum: ['flagged', 'awaiting_payment', 'active', 'expired', 'rejected', 'cancelled'],
        required: true,
        index: true,
    },
    flags: [String],
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewNote: String,
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPurchase' },
    startsAt: Date,
    endsAt: { type: Date, index: true },
}, { timestamps: true });

export default mongoose.model('PaidListing', paidListingSchema);
