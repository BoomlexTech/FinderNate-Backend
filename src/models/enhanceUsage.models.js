import mongoose from 'mongoose';

/** How many times someone used the photo enhancer in a calendar month (IST). Phase 5 #35. */
const EnhanceUsageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: String, required: true }, // "2026-11"
    count: { type: Number, default: 0 },
}, { timestamps: true });

EnhanceUsageSchema.index({ userId: 1, month: 1 }, { unique: true });

export default mongoose.model('EnhanceUsage', EnhanceUsageSchema);
