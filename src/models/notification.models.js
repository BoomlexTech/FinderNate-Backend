import mongoose from 'mongoose';

const NotificationSchema = new mongoose.Schema({
    receiverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        // Optional, because some notifications come from the platform rather
        // than from another person — business verification being the first.
        // Admins live in their own collection and are not Users, so there is no
        // honest value to put here for them.
        required: false,
        default: null
    },
    type: {
        type: String,
        // Phase 2 adds: story_like, story_comment (#32), repost (#56),
        // collab_invite / collab_accepted (#50), milestone (#46).
        enum: ['like', 'unlike', 'comment', 'follow', 'mention', 'message', 'tag', 'storyView', 'order', 'others', 'business_verification', 'subscription',
            'story_like', 'story_comment', 'repost', 'collab_invite', 'collab_accepted', 'milestone'],
        required: true
    },
    message: {
        type: String,
        trim: true
    },
    postId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Post',
        default: null
    },
    commentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
        default: null
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        default: null
    },
    storyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Story',
        default: null
    },
    // Small extras a notification type needs to render (e.g. the milestone
    // view count). Never user-controlled free text.
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    isRead: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// The list endpoint and the daily email digest (#10) both read a receiver's
// newest notifications first.
NotificationSchema.index({ receiverId: 1, createdAt: -1 });

export default mongoose.model('Notification', NotificationSchema);
