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
    // 👑 Group owner (Phase 3 #21). Groups created before this field existed
    // use createdBy; see utils/chatRoles.rules.js effectiveOwnerId().
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    // When each member joined, so ownership can pass to the longest-serving
    // admin or member when the owner leaves.
    memberSince: [{
        _id: false,
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joinedAt: { type: Date, default: Date.now },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }],

    // ⏳ Disappearing messages (Phase 3 #37). 0 = off; otherwise new messages
    // expire this many seconds after they're sent (24 hours, 7 days, 90 days).
    disappearing: {
        seconds: { type: Number, default: 0 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedAt: Date
    },

    // 🔒 End-to-end encryption (Phase 3 #2). Set the first time an encrypted
    // message is sent in a direct chat.
    e2ee: {
        enabled: { type: Boolean, default: false },
        since: Date
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
