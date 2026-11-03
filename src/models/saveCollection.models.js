import mongoose from 'mongoose';

/**
 * A private, named folder of saved posts (Phase 2 #54).
 *
 * Membership lives on SavedPost.collectionIds, so a post can sit in several
 * collections and unsaving it removes it from all of them at once. Only the
 * owner can ever read a collection.
 */
const SaveCollectionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    // Lower-cased copy so "Shoes" and "shoes" are the same collection.
    nameKey: { type: String, required: true }
}, { timestamps: true });

SaveCollectionSchema.index({ userId: 1, nameKey: 1 }, { unique: true });
SaveCollectionSchema.index({ userId: 1, updatedAt: -1 });

export default mongoose.model('SaveCollection', SaveCollectionSchema);
