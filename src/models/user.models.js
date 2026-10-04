import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { badgeForPlan } from "../constants/subscriptionBadges.js";

const UserSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 8 },
    fullName: { type: String, required: true },
    fullNameLower: { type: String, index: true },
    phoneNumber: String,
    dateOfBirth: String,
    gender: { type: String, enum: ['male', 'female', 'other', 'prefer-not-to-say'], default: 'prefer-not-to-say' },
    bio: String,
    profileImageUrl: String,
    location: String,
    address: String,
    // Privacy settings
    isPhoneNumberHidden: { type: Boolean, default: false },
    isAddressHidden: { type: Boolean, default: false },
    privacy: { type: String, enum: ['private', 'public'], default: 'public' },
    isFullPrivate: { type: Boolean, default: false },
    // Messaging privacy settings
    messagingPrivacy: {
        onlineStatus: {
            type: String,
            enum: ['everyone', 'followers', 'nobody'],
            default: 'everyone'
        },
        lastSeen: {
            type: String,
            enum: ['everyone', 'followers', 'nobody'],
            default: 'everyone'
        }
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    link: String,
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    posts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Post' }],
    isBusinessProfile: { type: Boolean, default: false },
    businessProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business' },
    isBlueTickVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String },
    emailOTPExpiry: { type: Date },
    emailOTP: { type: String },
    passwordResetOTP: String,
    passwordResetOTPExpiry: Date,

    isPhoneVerified: { type: Boolean, default: false },
    phoneVerificationCode: { type: String },
    phoneVerificationExpiry: { type: Date },
    refreshToken: { type: String, select: false },
    accountStatus: {
        type: String,
        enum: ['active', 'deactivated', 'banned'],
        default: 'active'
    },
    isDeleted: { type: Boolean, default: false },
    
    deletedAt: { type: Date, default: null },
    adminActionReason: { type: String, default: null },
    // Service post preferences
    /**
     * Chat background wallpaper — an id from constants/chatWallpapers.js, or
     * null.
     *
     * Per USER, not per chat, and deliberately not stored on the Chat document
     * where themeColor lives: themeColor is shared with the other participant
     * and broadcast to them over a socket, whereas a wallpaper is one person's
     * own view of their own app. Choosing it should not change what anyone else
     * sees.
     *
     * null means no wallpaper, and must render as the chat looked before this
     * existed — not as a white or default background.
     */
    chatWallpaper: { type: String, default: null },

    servicePostPreferences: {
        enableAutoFill: { type: Boolean, default: true }
    },
    // Product post preferences
    productPostPreferences: {
        enableAutoFill: { type: Boolean, default: true }
    },
    // FCM Token for push notifications
    fcmToken: {
        type: String,
        default: null
    },
    fcmTokenUpdatedAt: {
        type: Date,
        default: null
    },
    /**
     * LEGAL ACCEPTANCE TRACKING.
     *
     * Three paths write this: legal.controllers.js (through the model, so the
     * defaults below apply), and the two account-creation paths —
     * controllers/user/auth.js#verifyRegistrationOTP and
     * controllers/user/guestAccount.js — which insert through the RAW driver,
     * where NONE of these defaults run. Those two must therefore set every key
     * explicitly; auth.js does it via buildSignupLegalAcceptance in
     * legal.controllers.js. An omitted key is absent from the stored document,
     * not `false`/`null`, and getAcceptanceStatus would read `undefined`.
     */
    legalAcceptance: {
        termsAccepted:         { type: Boolean, default: false },
        termsAcceptedAt:       { type: Date,    default: null },
        termsVersion:          { type: String,  default: null },
        privacyAccepted:       { type: Boolean, default: false },
        privacyAcceptedAt:     { type: Date,    default: null },
        privacyVersion:        { type: String,  default: null },
        sellerTermsAccepted:   { type: Boolean, default: false },
        sellerTermsAcceptedAt: { type: Date,    default: null },
        sellerTermsVersion:    { type: String,  default: null },
        communityAccepted:     { type: Boolean, default: false },
        communityAcceptedAt:   { type: Date,    default: null },
        communityVersion:      { type: String,  default: null },
        acceptanceIP:          { type: String,  default: null },
        acceptanceUserAgent:   { type: String,  default: null },
    },

    /**
     * 13+ ATTESTATION FOR ACCOUNTS CREATED BY GUEST CHECKOUT.
     *
     * Ordinary registration proves the age gate with `dateOfBirth`. A guest
     * checkout has no date of birth — the buyer ticks "I am 13 or older" and
     * inventing a birth date to satisfy the gate would be fabricating a fact
     * about a person — so the attestation itself IS the compliance record.
     *
     * It must be a real schema path. guestAccount.js writes it through the raw
     * driver, which happily stored it while Mongoose's strict mode dropped it
     * from every ordinary read: the record existed in the collection and was
     * invisible to all application code, including anything that would ever be
     * asked to produce it. Declared here so `User.findById(...)` returns it.
     */
    guestAgeAttestation: {
        attested:   { type: Boolean, default: false },
        minimumAge: { type: Number,  default: null },
        attestedAt: { type: Date,    default: null },
        // 'guest_checkout' for the shareable-payment-link flow.
        source:     { type: String,  default: null },
        // EVIDENCE. Must be req.ip (resolved through app.js `trust proxy`),
        // never a raw x-forwarded-for value, which the caller controls.
        ip:         { type: String,  default: null },
        userAgent:  { type: String,  default: null },
    }
}, { timestamps: true });

// 🔐 Hash password before saving, and keep fullNameLower in step
UserSchema.pre("save", async function (next) {
    // The fullName branch used to sit AFTER `if (!this.isModified("password"))
    // return next()`, so it only ran when the password changed in the same
    // save — renaming an account left fullNameLower stale and name search kept
    // matching the old name. Handle the two independently.
    if (this.isModified("fullName") && this.fullName) {
        this.fullNameLower = this.fullName.toLowerCase();
    }

    if (!this.isModified("password")) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
}
);



// 🔐 Compare password
UserSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// 🔐 Access Token
UserSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            username: this.username,
            fullName: this.fullName,
            phoneNumber: this.phoneNumber
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY
        }
    );
};

// 🔐 Refresh Token
UserSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        {
            _id: this._id
        },
        process.env.REFRESH_TOKEN_SECRET,
        {
            expiresIn: process.env.REFRESH_TOKEN_EXPIRY
        }
    );
};

// 📞 Check if user has calling features access
UserSchema.methods.hasCallingAccess = async function () {
    const Subscription = mongoose.model('Subscription');

    // Business profiles always have calling access
    if (this.isBusinessProfile) {
        return true;
    }

    // Check if user has an active paid subscription
    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    // Free users don't have calling access
    if (!subscription || subscription.plan === 'free') {
        return false;
    }

    // All paid plans (basic, pro, premium, business) have calling access
    return true;
};

// 📋 Get user subscription tier
UserSchema.methods.getSubscriptionTier = async function () {
    const Subscription = mongoose.model('Subscription');

    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    return subscription ? subscription.plan : 'free';
};

// 🏅 Get user subscription badge
UserSchema.methods.getSubscriptionBadge = async function () {
    const Subscription = mongoose.model('Subscription');

    // Check active subscription first
    const subscription = await Subscription.findOne({
        userId: this._id,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    if (!subscription || subscription.plan === 'free') {
        return null; // No badge for free users
    }

    return badgeForPlan(subscription.plan);
};


export const User = mongoose.model("User", UserSchema);
