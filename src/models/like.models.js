import mongoose from 'mongoose';

const LikeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        required: function () { return !this.commentId; }, // Only required if commentId is not present
        index: true
    },
    commentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        required: function () { return !this.postId; }, // Only required if postId is not present
        default: null // Optional  supports likes on comments too
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// 🛡 Prevent duplicate likes (one like per user per post/comment)
LikeSchema.index({ userId: 1, postId: 1 }, { unique: true, partialFilterExpression: { postId: { $type: "objectId" } } });
LikeSchema.index({ userId: 1, commentId: 1 }, { unique: true, partialFilterExpression: { commentId: { $type: "objectId" } } });

// Business Insights: likes received on a set of posts within a date window.
LikeSchema.index({ postId: 1, createdAt: -1 });

export default mongoose.model('Like', LikeSchema);
