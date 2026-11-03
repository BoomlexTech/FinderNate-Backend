import mongoose from 'mongoose';

/**
 * Push-notification devices per account (Phase 3 #25).
 *
 * Before this, each account held one `User.fcmToken`, and saving a token took
 * it away from every other account. So two phones on one account didn't both
 * get notifications, and one phone couldn't hold two accounts. A row here is
 * one (account, device token) pair: a phone signed in to three accounts has
 * three rows with the same token, and an account on two phones has two rows.
 *
 * `User.fcmToken` is still written by older app versions and still read when
 * sending, so they keep working.
 */
const userDeviceSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web', 'other'], default: 'other' },
    // Stable id the app generates per install, so one install's accounts can
    // be found together even after Firebase rotates the token.
    installId: { type: String, default: null },
    appVersion: { type: String, default: null },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

userDeviceSchema.index({ userId: 1, token: 1 }, { unique: true });
userDeviceSchema.index({ token: 1 });
userDeviceSchema.index({ installId: 1 }, { partialFilterExpression: { installId: { $type: 'string' } } });

export const MAX_ACCOUNTS_PER_DEVICE = 5;

export default mongoose.model('UserDevice', userDeviceSchema);
