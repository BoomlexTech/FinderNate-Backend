import mongoose from 'mongoose';

/**
 * Daily view counts for verified businesses (Phase 4 #75): profile views and
 * views of their product, service and business posts, by IST day. Feeds the
 * "people viewed your profile" notifications and the Insights chart.
 */
const businessViewDailySchema = new mongoose.Schema({
    businessUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (IST)
    profileViews: { type: Number, default: 0 },
    postViews: { type: Number, default: 0 },
    instantSent: { type: Number, default: 0 },
    digestSentAt: Date,
}, { timestamps: true });

businessViewDailySchema.index({ businessUserId: 1, day: -1 }, { unique: true });
businessViewDailySchema.index({ day: 1, digestSentAt: 1 });

export default mongoose.model('BusinessViewDaily', businessViewDailySchema);
