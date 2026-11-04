import mongoose from 'mongoose';

/**
 * A sound that can go under a post, vibe or story (Phase 5 #29).
 *
 *  - 'library'  royalty-free tracks the admin uploads
 *  - 'original' the sound of someone's own vibe, reusable through "Use this audio"
 *
 * Licensed film and pop songs are deliberately absent: they need a licence
 * deal first. `licence` records where each library track came from so a
 * takedown request can be answered.
 */
const SoundSchema = new mongoose.Schema({
    source: { type: String, enum: ['library', 'original'], required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    artist: { type: String, trim: true, maxlength: 120, default: '' },
    audioUrl: { type: String, required: true },
    coverUrl: { type: String, default: '' },
    durationSec: { type: Number, default: 0 },
    genre: { type: String, trim: true, lowercase: true, maxlength: 40, default: '' },
    mood: { type: String, trim: true, lowercase: true, maxlength: 40, default: '' },
    language: { type: String, trim: true, lowercase: true, maxlength: 20, default: '' },
    licence: {
        type: new mongoose.Schema({
            type: { type: String, enum: ['royalty_free', 'cc0', 'cc_by', 'licensed', 'user'], default: 'royalty_free' },
            provider: { type: String, default: '' },
            attribution: { type: String, default: '' },
            url: { type: String, default: '' },
        }, { _id: false }),
        default: undefined,
    },
    // 'hidden': taken down by an admin. 'held': the vibe it came from is in the
    // Bin (back to 'active' if restored). 'removed': that vibe was deleted for good.
    status: { type: String, enum: ['active', 'hidden', 'held', 'removed'], default: 'active', index: true },
    // Original audio only
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    sourcePostId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: undefined },
    allowReuse: { type: Boolean, default: true },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: undefined },
}, { timestamps: true });

SoundSchema.index({ status: 1, source: 1, usageCount: -1, lastUsedAt: -1 });
SoundSchema.index({ status: 1, source: 1, createdAt: -1 });
SoundSchema.index({ sourcePostId: 1 }, { unique: true, sparse: true });
SoundSchema.index({ ownerId: 1, createdAt: -1 }, { sparse: true });

export default mongoose.model('Sound', SoundSchema);
