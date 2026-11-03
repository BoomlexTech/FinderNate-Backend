import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
    chatId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chat',
        required: true,
        index: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    message: {
        type: String,
        required: true
    },
    messageType: {
        type: String,
        // Phase 3: system (group events), gif and sticker (#7), encrypted (#2).
        enum: ['text', 'image', 'video', 'file', 'audio', 'location', 'payment_link', 'checkout', 'order_update', 'call', 'contact_seller', 'story_reply', 'shared_post', 'system', 'gif', 'sticker', 'encrypted'],
        default: 'text'
    },
    mediaUrl: String,
    fileName: String,
    fileSize: Number,
    duration: Number, // for audio/video
    location: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    readBy: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    deliveryStatus: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        status: {
            type: String,
            enum: ['sent', 'delivered', 'seen'],
            default: 'sent'
        },
        deliveredAt: Date,
        seenAt: Date
    }],
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedAt: Date,
    deletedFor: [{
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        deletedAt: {
            type: Date,
            default: Date.now
        }
    }],
    deletedForEveryone: {
        type: Boolean,
        default: false,
        index: true
    },
    deletedForEveryoneAt: Date,
    editedAt: Date,
    originalMessage: String, // Store original message for potential restoration
    reactions: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        emoji: String,
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    // 🏷️ Product/Business reference for contact-initiated chats
    productReference: {
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
        productVideos: [{ url: String, thumbnailUrl: String }],
        productPrice: Number,
        productType: {
            type: String,
            enum: ['product', 'service', 'business']
        },
        productDescription: String,
        location: String
    },
    /**
     * The story a message was sent in reply to.
     *
     * A SNAPSHOT, not a join — the same shape of decision as productReference
     * above, and for a stronger reason: stories expire after 24 hours and are
     * deleted. A reference that only held the id would render as a blank card
     * the next day, so the conversation would lose the thing it was about.
     * Copying the media url and caption in means "😍" still has its picture
     * attached a week later.
     *
     * storyId is kept anyway, so a story that IS still live can be opened.
     */
    storyReference: {
        storyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Story' },
        ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        ownerUsername: String,
        mediaUrl: String,
        mediaType: { type: String, enum: ['image', 'video'] },
        caption: String,
        // When the snapshot was taken, so a client can say "expired" rather
        // than silently offering a tap that goes nowhere.
        capturedAt: Date,
    },
    // 🔁 In-app share of a post or vibe (Phase 2 #24). A snapshot taken when
    // the message was sent (see utils/sharedPost.utils.js); tapping the bubble
    // opens the live post, which is checked for visibility again.
    sharedPost: {
        postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        authorUsername: String,
        authorFullName: String,
        authorProfileImageUrl: String,
        postType: String,
        contentType: String,
        isVibe: Boolean,
        caption: String,
        mediaType: String,
        thumbnailUrl: String,
        title: String,
        price: Number,
        currency: String,
        capturedAt: Date,
    },
    // 🛎 Group events (Phase 3 #21): "Asha made Ravi an admin". `message`
    // holds the rendered sentence for clients that don't know this type.
    system: {
        action: String,
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        targetIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        data: mongoose.Schema.Types.Mixed
    },
    // 🎞 GIF or sticker (Phase 3 #7). Looked up by id through our GIPHY
    // proxy; the client never supplies the URLs.
    gif: {
        provider: { type: String, default: 'giphy' },
        id: String,
        title: String,
        url: String,
        mp4Url: String,
        previewUrl: String,
        width: Number,
        height: Number
    },
    // ⏳ Disappearing messages (Phase 3 #37): when this message is removed.
    expiresAt: { type: Date, default: null },
    // 👁 View-once photo or video (Phase 3 #48). The media link is only handed
    // out by the open endpoint, once per recipient.
    viewOnce: { type: Boolean, default: false },
    viewOnceOpenedBy: [{
        _id: false,
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        openedAt: Date
    }],
    // When the media file is due to be deleted (shortly after opening, or
    // 14 days after sending if never opened). Cleared once it's gone.
    viewOnceMediaDeleteAt: { type: Date, default: null },
    viewOnceExpired: { type: Boolean, default: false },
    // 🔒 End-to-end encrypted payload (Phase 3 #2). The server cannot read
    // it; see utils/e2ee.rules.js for the format.
    e2ee: {
        type: {
            _id: false,
            v: Number,
            alg: String,
            senderDeviceId: String,
            ephemeralPublicKey: String,
            nonce: String,
            ciphertext: String,
            signature: String,
            keys: [{
                _id: false,
                userId: String,
                deviceId: String,
                nonce: String,
                wrappedKey: String
            }]
        },
        default: undefined
    },
    // Links to this message's encrypted attachments (ciphertext only), so
    // they can be deleted when the message disappears or is opened once.
    e2eeBlobUrls: { type: [String], default: undefined },
    // 📤 Forwarding support
    forwardedFrom: {
        messageId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Message'
        },
        chatId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Chat'
        },
        originalSender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }
    },
    isForwarded: {
        type: Boolean,
        default: false,
        index: true
    },
    // 📌 Pinning support
    isPinned: {
        type: Boolean,
        default: false,
        index: true
    },
    pinnedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    pinnedAt: Date,
    // ✏️ Editing support
    isEdited: {
        type: Boolean,
        default: false
    },
    originalContent: String, // Original content before edit
    // 🎤 Voice message metadata
    waveform: [Number], // For voice message visualization
    // 🔗 Link preview cache
    linkPreview: {
        url: String,
        title: String,
        description: String,
        image: String,
        siteName: String,
        fetchedAt: Date
    },
    // 🛒 Checkout details for in-chat checkout messages
    checkoutDetails: {
        postId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Post'
        },
        productName: String,
        productDescription: String,
        productImages: [String],
        productCategory: String,
        productType: {
            type: String,
            enum: ['product', 'service']
        },
        specifications: [{
            key: String,
            value: String
        }],
        variants: [{
            name: String,
            options: [String]
        }],
        deliveryOptions: String,
        sellerLocation: String,
        // Price breakdown
        basePrice: Number,
        shippingCharges: Number,
        gstPercent: Number,
        gstAmount: Number,
        totalPrice: Number,
        currency: {
            type: String,
            default: 'INR'
        },
        // Seller info
        sellerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        sellerName: String,
        sellerUsername: String,
        sellerAvatar: String,
        // Payment link reference
        paymentLinkId: String,
        paymentUrl: String,
        // Status tracking
        checkoutStatus: {
            type: String,
            enum: ['pending', 'paid', 'expired'],
            default: 'pending'
        },
        expiresAt: Date
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Compound indexes for optimal query performance
MessageSchema.index({ chatId: 1, timestamp: -1 }); // For message fetching
MessageSchema.index({ chatId: 1, isDeleted: 1, timestamp: -1 }); // For non-deleted messages
MessageSchema.index({ chatId: 1, isDeleted: 1, readBy: 1 }); // For unread count queries
MessageSchema.index({ sender: 1, timestamp: -1 }); // For user's sent messages
MessageSchema.index({ chatId: 1, 'deliveryStatus.userId': 1, 'deliveryStatus.status': 1 }); // For delivery status queries
MessageSchema.index({ chatId: 1, deletedForEveryone: 1 }); // For deleted messages filtering
MessageSchema.index({ chatId: 1, isPinned: 1, pinnedAt: -1 }); // For pinned messages queries
MessageSchema.index({ chatId: 1, isForwarded: 1 }); // For forwarded messages queries
MessageSchema.index({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: 'date' } } }); // Disappearing messages purge
MessageSchema.index({ viewOnceMediaDeleteAt: 1 }, { partialFilterExpression: { viewOnceMediaDeleteAt: { $type: 'date' } } }); // View-once media purge

// Virtual for unread status (per user)
MessageSchema.virtual('isUnread').get(function () {
    // This would be calculated per user in queries
    return false;
});

export default mongoose.model('Message', MessageSchema); 