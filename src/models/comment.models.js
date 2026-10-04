import mongoose from 'mongoose';

const CommentSchema = new mongoose.Schema({
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    content: {
        type: String,
        required: true,
        trim: true
    },
    parentCommentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null // For replies - immediate parent
    },
    rootCommentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null // For thread tracking - top-level comment in the thread
    },
    replyToUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null // User being replied to (for Facebook-style mentions)
    },
    likes: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    isEdited: {
        type: Boolean,
        default: false
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Business Insights: comments received on a set of posts within a date window.
CommentSchema.index({ postId: 1, createdAt: -1 });

export default mongoose.model('Comment', CommentSchema);
