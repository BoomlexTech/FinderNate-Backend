import mongoose from 'mongoose';

/**
 * Paid ads (Phase 4 #27). Three types: contact (WhatsApp or call), app
 * promotion and website. Cost = daily fee × days, paid up front.
 * draft → awaiting_payment → scheduled → running → completed
 * (or cancelled / rejected).
 */
const adCampaignSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['contact', 'app', 'website'], required: true },
    // Promote an existing post, or a standalone creative.
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
    creative: {
        headline: { type: String, maxlength: 80 },
        body: { type: String, maxlength: 300 },
        mediaUrl: String,
        mediaType: { type: String, enum: ['image', 'video'], default: 'image' },
    },
    cta: {
        label: { type: String, maxlength: 24 },
        whatsapp: String,
        phone: String,
        url: String,
        playStoreUrl: String,
        appStoreUrl: String,
    },
    days: { type: Number, required: true, min: 1 },
    dailyFee: { type: Number, required: true },
    gstPercent: { type: Number, default: 18 },
    amount: { type: Number, required: true },
    gst: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: {
        type: String,
        enum: ['draft', 'awaiting_payment', 'scheduled', 'running', 'completed', 'cancelled', 'rejected'],
        default: 'draft',
        index: true,
    },
    requestedStartAt: Date,
    startAt: Date,
    endAt: Date,
    paidAt: Date,
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPurchase' },
    rejectionReason: String,
    stats: {
        impressions: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        daily: { type: Map, of: new mongoose.Schema({ impressions: Number, clicks: Number }, { _id: false }), default: {} },
    },
}, { timestamps: true });

adCampaignSchema.index({ status: 1, startAt: 1, endAt: 1 });

export default mongoose.model('AdCampaign', adCampaignSchema);
