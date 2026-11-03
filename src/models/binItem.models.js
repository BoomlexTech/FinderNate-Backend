import mongoose from 'mongoose';

/**
 * The Bin (Phase 2 #15): something the user deleted, kept for 15 days.
 *
 * Deleting moves the whole document here and removes it from its own
 * collection, so every feed, profile and search query stops seeing it without
 * any of them having to learn a new filter. Likes, comments, saves and the
 * media files are left in place; restoring puts the document back under the
 * SAME _id, which reconnects all of them.
 *
 * jobs/binPurge.job.js deletes the media and the related rows once purgeAfter
 * has passed, or straight away for "Delete now".
 */
const BinItemSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // 'post' covers photos, vibes (reels/videos), notes (tweets) and listings.
    kind: { type: String, enum: ['post', 'story'], required: true },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The full original document, exactly as it was stored.
    doc: { type: mongoose.Schema.Types.Mixed, required: true },
    // Copied out of `doc` for the Bin screen.
    preview: {
        postType: String,
        contentType: String,
        caption: String,
        thumbnailUrl: String,
        mediaType: String
    },
    deletedAt: { type: Date, default: Date.now },
    purgeAfter: { type: Date, required: true },
    // Set by a purge worker that has taken this row (see binPurge.job.js).
    purgeClaimedAt: { type: Date, default: null, select: false }
});

BinItemSchema.index({ userId: 1, deletedAt: -1 });
BinItemSchema.index({ originalId: 1 }, { unique: true });
BinItemSchema.index({ purgeAfter: 1, purgeClaimedAt: 1 });

export default mongoose.model('BinItem', BinItemSchema);
