import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const AdminSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    password: { type: String, required: true, minlength: 8 },
    fullName: { type: String, required: true },
    role: {
        type: String,
        default: 'admin' // Admin IS the super admin
    },
    permissions: {
        verifyAadhaar: { type: Boolean, default: true },
        manageReports: { type: Boolean, default: true },
        manageUsers: { type: Boolean, default: true },
        manageBusiness: { type: Boolean, default: true },
        systemSettings: { type: Boolean, default: true },
        viewAnalytics: { type: Boolean, default: true },
        deleteContent: { type: Boolean, default: true },
        banUsers: { type: Boolean, default: true }
    },
    profileImageUrl: String,
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date },
    refreshToken: { type: String, select: false },
    // Forgot password: only the SHA-256 of the emailed token is stored, so a
    // database read cannot be turned into a reset link.
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    passwordResetRequestedAt: { type: Date, select: false },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null // null for first admin account
    },
    activityLog: [{
        action: String,
        targetType: String, // 'user', 'business', 'post', 'report'
        targetId: String,
        details: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

// Hash password before saving
AdminSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// Compare password
AdminSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// Generate Access Token
AdminSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            username: this.username,
            fullName: this.fullName,
            role: this.role
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY
        }
    );
};

// Generate Refresh Token
AdminSchema.methods.generateRefreshToken = function () {
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

// Log admin activity
AdminSchema.methods.logActivity = function (action, targetType, targetId, details) {
    this.activityLog.push({
        action,
        targetType,
        targetId,
        details
    });

    // Keep only last 1000 activities
    if (this.activityLog.length > 1000) {
        this.activityLog = this.activityLog.slice(-1000);
    }

    return this.save();
};

export const Admin = mongoose.model('Admin', AdminSchema);
