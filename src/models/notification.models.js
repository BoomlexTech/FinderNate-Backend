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
        enum: ['like', 'unlike', 'comment', 'follow', 'mention', 'message', 'tag', 'storyView', 'order', 'others', 'business_verification', 'subscription'],
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
    isRead: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

export default mongoose.model('Notification', NotificationSchema);
