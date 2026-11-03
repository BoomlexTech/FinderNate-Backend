import mongoose from 'mongoose';

/**
 * "Not interested" on a post or vibe (Phase 2 #68).
 *
 * The post itself disappears from that viewer's feeds, and its author,
 * category and hashtags are ranked lower for them (utils/feedSignals.utils.js).
 * The author/category/hashtags are copied here so the signal survives the
 * post being edited or deleted.
 *
 * Kept for 180 days, after which the viewer's taste is allowed to come back.
 */
const NotInterestedSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    category: { type: String, default: null },
    hashtags: { type: [String], default: undefined },
    createdAt: { type: Date, default: Date.now }
});

NotInterestedSchema.index({ userId: 1, postId: 1 }, { unique: true });
NotInterestedSchema.index({ userId: 1, createdAt: -1 });
NotInterestedSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default mongoose.model('NotInterested', NotInterestedSchema);
