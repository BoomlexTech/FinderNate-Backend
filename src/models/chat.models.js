import mongoose from 'mongoose';

const ChatSchema = new mongoose.Schema({
    // 👥 Users involved in the chat (1-on-1 or group)
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],

    // 🏷 Chat type and metadata
    chatType: {
        type: String,
        enum: ['direct', 'group'],
        default: 'direct'
    },

    // 📫 Chat status (for message requests)
    status: {
        type: String,
        enum: ['active', 'requested', 'declined'],
        default: 'active'
    },

    // 👤 Group chat specific fields
    groupName: String,
    groupDescription: String,
    groupImage: String,
    admins: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    // 💬 Messages are now stored in separate Message model
    // Reference to last message for quick access
    lastMessageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },

    // 🕒 Last message info for chat list
    lastMessage: {
        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        message: String,
        timestamp: Date
    },
    lastMessageAt: {
        type: Date,
        default: Date.now
    },

    // 🔕 Mute settings
    // Legacy list: a user here counts as muted with no end time. Nothing writes
    // to it any more; `mutes` below is the live field.
    mutedBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    // Per-user notification mute (Phase 2 #38). `until: null` means "until I
    // turn it off". Muting only silences push notifications for that user;
    // messages, unread counts and the chat itself are unaffected.
    // select:false because who muted a chat is private to each participant:
    // only getUserChats (the caller's own state) and addMessage (push
    // filtering) ask for it, with .select('+mutes').
    mutes: {
        type: [{
            _id: false,
            userId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
                required: true
            },
            until: {
                type: Date,
                default: null
            }
        }],
        select: false
    },

    // 📍 Pinned messages
    pinnedMessages: [{
        type: mongoose.Schema.Types.ObjectId
    }],

    // 🚫 Blocked users (for group chats)
    blockedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],

    // 🎨 Chat theme color for message bubbles
    themeColor: {
        type: String,
        default: '#DBB42C',
        validate: {
            validator: function(v) {
                return /^#[0-9A-F]{6}$/i.test(v);
            },
            message: props => `${props.value} is not a valid hex color code!`
        }
    },

    // 📊 Chat statistics
    stats: {
        totalMessages: {
            type: Number,
            default: 0
        },
        totalParticipants: {
            type: Number,
            default: 0
        }
    },

    // 🏷️ Product/Business context for business-initiated chats
    productContext: {
        postId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Post'
        },
        businessId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Business'
        },
        productName: String,
        productImage: String,
        productPrice: Number,
        productType: {
            type: String,
            enum: ['product', 'service', 'business']
        },
        productDescription: String,
        location: String
    }

}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// 📛 Indexes for better performance
ChatSchema.index({ participants: 1 });
ChatSchema.index({ chatType: 1 });
ChatSchema.index({ status: 1 });
ChatSchema.index({ lastMessageAt: -1 });
ChatSchema.index({ 'messages.timestamp': -1 });

// 🔄 Virtual for unread count
ChatSchema.virtual('unreadCount').get(function () {
    // This would be calculated per user in the controller
    return 0;
});

//  Pre-save middleware to update stats
ChatSchema.pre('save', function (next) {
    if (this.isModified('participants')) {
        this.stats.totalParticipants = this.participants.length;
    }
    next();
});

export default mongoose.model('Chat', ChatSchema);
