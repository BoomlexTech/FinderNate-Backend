import mongoose from 'mongoose';

// Instagram-style saved posts: Always private, only visible to the user who saved them
const SavedPostSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true
    },
    savedAt: {
        type: Date,
        default: Date.now
    },
    // Phase 2 #54: the named collections this save is filed in. A save with no
    // collection is still listed under "All saved".
    collectionIds: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SaveCollection' }],
        default: undefined
    }
}, { timestamps: true });

SavedPostSchema.index({ userId: 1, collectionIds: 1, savedAt: -1 });

// 🛡 Prevent saving the same post multiple times by same user
SavedPostSchema.index({ userId: 1, postId: 1 }, { unique: true });

// Business Insights: saves received on a set of posts within a date window.
SavedPostSchema.index({ postId: 1, createdAt: -1 });

export default mongoose.model('SavedPost', SavedPostSchema);
