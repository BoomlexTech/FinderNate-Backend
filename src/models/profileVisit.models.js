import mongoose from 'mongoose';

/**
 * One row per (profile, visitor), refreshed on every visit (Phase 2 #65).
 *
 * Not written for visitors who hide their visits (User.profileVisitsHidden),
 * nor for a person looking at their own profile. Rows expire 30 days after
 * the last visit.
 */
const ProfileVisitSchema = new mongoose.Schema({
    profileUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    visitorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastVisitedAt: { type: Date, default: Date.now },
    visitCount: { type: Number, default: 1 }
});

ProfileVisitSchema.index({ profileUserId: 1, visitorId: 1 }, { unique: true });
ProfileVisitSchema.index({ profileUserId: 1, lastVisitedAt: -1 });
ProfileVisitSchema.index({ lastVisitedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('ProfileVisit', ProfileVisitSchema);
