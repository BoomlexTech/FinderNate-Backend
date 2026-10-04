import mongoose from 'mongoose';

const SocialMediaSchema = new mongoose.Schema({
    platform: String,
    url: String
}, { _id: false });

const ContactSchema = new mongoose.Schema({
    phone: String,
    email: { type: String, lowercase: true },
    website: String,
    socialMedia: [SocialMediaSchema]
}, { _id: false });

// Document Schema for business verification documents
const DocumentSchema = new mongoose.Schema({
    documentType: {
        type: String,
        required: true,
        enum: ['gst', 'aadhaar', 'pan', 'license', 'registration', 'other']
    },
    documentName: { type: String, required: true },
    documentUrl: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    remarks: { type: String }
}, { _id: true });

// 🌐 GeoJSON Point Schema for business location
const GeoJSONPointSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
    },
    coordinates: {
        type: [Number], // [longitude, latitude]
        index: '2dsphere'
    }
}, { _id: false });

const LocationSchema = new mongoose.Schema({
    address: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    coordinates: GeoJSONPointSchema, // Add coordinates for live location
    isLiveLocationEnabled: { type: Boolean, default: false }, // Toggle for live location feature
    lastLocationUpdate: { type: Date } // Track when location was last updated
}, { _id: false });

const BusinessSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        unique: true, // Ensure one business profile per user
        index: true
    },
    businessName: { type: String, trim: true, index: true },
    businessType: { type: String, index: true },
    description: { type: String },
    category: { type: String, index: true },
    subcategory: { type: String, index: true },
    contact: ContactSchema,
    location: LocationSchema,
    rating: { type: Number },
    tags: { type: [String], index: true },
    website: { type: String },
    gstNumber: { type: String, required: false },
    aadhaarNumber: { type: String, required: false },

    // Array of verification documents
    documents: [DocumentSchema],

    // Bank details for payment settlement
    bankDetails: {
        accountHolderName: { type: String, trim: true },
        bankName: { type: String, trim: true },
        accountNumber: { type: String },
        ifscCode: { type: String, uppercase: true },
        accountType: {
            type: String,
            enum: ['savings', 'current'],
            lowercase: true
        },
        upiId: { type: String, lowercase: true },
        branchName: { type: String, trim: true },
        paymentQRCode: { type: String }, // URL to QR code image for manual payments
        isVerified: { type: Boolean, default: false },
        verifiedAt: { type: Date },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        updatedAt: { type: Date }
    },

    logoUrl: { type: String },
    isVerified: { type: Boolean, default: false },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    insights: {
        views: { type: Number, default: 0 },
        clicks: { type: Number, default: 0 },
        conversions: { type: Number, default: 0 }
    },
    plan: {
        type: String,
        enum: ['plan1', 'plan2', 'plan3', 'plan4'],
        default: 'plan1'
    },
    subscriptionStatus: {
        type: String,
        enum: ['active', 'inactive', 'pending'],
        default: 'pending'
    },
    // Admin verification fields
    verificationStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    verificationRemarks: { type: String },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    rejectedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // Document-specific verification fields
    gstVerified: { type: Boolean, default: false },
    gstVerifiedAt: { type: Date },
    gstVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    aadhaarVerified: { type: Boolean, default: false },
    aadhaarVerifiedAt: { type: Date },
    aadhaarVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // Post type controls for business profile
    postSettings: {
        allowProductPosts: { type: Boolean, default: true },
        allowServicePosts: { type: Boolean, default: true }
    },

    // The named contact a Corporate subscriber is promised. Contact details are
    // copied in rather than referenced, so the manager need not be an Admin user;
    // adminId is only set when they are.
    accountManager: {
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
        name: { type: String, trim: true },
        email: { type: String, trim: true, lowercase: true },
        phone: { type: String, trim: true },
        hours: { type: String, trim: true },
        assignedAt: { type: Date },
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
    },

    // Flag to track if business profile is fully created (one-time creation)
    isProfileCompleted: { type: Boolean, default: false }
}, { timestamps: true });

// 🚀 Auto-verify business when subscription becomes active
BusinessSchema.pre('save', async function (next) {
    // Check if subscriptionStatus is being modified and set to 'active'
    if (this.isModified('subscriptionStatus') && this.subscriptionStatus === 'active') {
        // Automatically verify the business
        this.isVerified = true;

    }
    next();
});

export default mongoose.model('Business', BusinessSchema);
