import mongoose from 'mongoose';

/**
 * A saved, unpublished post, vibe or note (Phase 2 #70).
 *
 * `payload` is the composer's own state (caption, product details, switches,
 * and so on) so a draft reopens exactly as it was left; the server only
 * bounds its size. Media is uploaded when the draft is saved (POST
 * /drafts/media) and kept until the draft is published or deleted, at which
 * point the clients send the files again with the real post.
 *
 * The older fields (content, taggedUsers, location, tags) are kept because
 * the model predates the drafts API; nothing reads them now.
 */
const DraftSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['Post', 'Reel', 'Story', 'Tweet'],
        required: true
    },
    postType: { type: String, enum: ['photo', 'reel', 'video', 'tweet'], default: 'photo' },
    contentType: { type: String, enum: ['normal', 'product', 'service', 'business'], default: 'normal' },
    // Short text for the drafts list (caption or product name).
    title: { type: String, trim: true, maxlength: 200, default: '' },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    content: {
        type: String,
        trim: true
    },
    media: [{
        url: String,
        thumbnailUrl: String,
        type: { type: String, enum: ['image', 'video'] },
        width: Number,
        height: Number,
        _id: false
    }],
    taggedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    location: String,
    tags: [String],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: { type: Date, default: Date.now },
    isAutoSaved: {
        type: Boolean,
        default: false
    }
});

DraftSchema.index({ userId: 1, updatedAt: -1 });

export default mongoose.model('Draft', DraftSchema);
