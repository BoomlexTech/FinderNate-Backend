import mongoose from 'mongoose';

/**
 * Ledger of boosts: one row per time-boxed boost of one post.
 *
 * A ledger rather than a flag on Post, so the monthly cap survives the post
 * being deleted and a report can be shown after the boost has ended.
 *
 * `status` is deliberately NOT stored. scheduled / active / ended are a pure
 * function of startsAt and endsAt (see boostStateOf in utils/boostEntitlement.js),
 * so a stored value would only go stale: nothing runs on a timer to update it.
 * The one thing time cannot tell us is a cancellation, so that is `cancelledAt`.
 */
const PostBoostSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The tier the boost was bought on. Serving re-derives the weight from the
    // author's CURRENT plan, so a lapse and re-subscribe cannot keep a stale
    // Corporate weight; this is the record of what was purchased.
    plan: { type: String, enum: ['small_business', 'corporate'], required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, enum: ['user', 'post_deleted'], default: undefined },
    // Times the post was served as promoted in the feed or Explore (not unique
    // viewers; the author's own views are skipped).
    impressions: { type: Number, default: 0 },
    // Same counter split by IST calendar day, keyed YYYY-MM-DD.
    daily: { type: Map, of: Number, default: {} },
    createdAt: { type: Date, default: Date.now }
});

// "My boosts" list and the monthly count (startsAt within a month).
PostBoostSchema.index({ userId: 1, startsAt: -1 });
// Overlap checks for one post.
PostBoostSchema.index({ postId: 1, startsAt: 1 });
// Serve-time read of everything live right now.
PostBoostSchema.index({ cancelledAt: 1, endsAt: 1, startsAt: 1 });

export default mongoose.model('PostBoost', PostBoostSchema);
