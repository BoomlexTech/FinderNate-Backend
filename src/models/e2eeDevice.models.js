import mongoose from 'mongoose';

/**
 * Public-key directory for end-to-end encryption (Phase 3 #2). One row per
 * signed-in phone or browser. Only PUBLIC keys are stored; private keys never
 * leave the device (except inside the user's PIN-encrypted backup, which the
 * server cannot open).
 *
 * Keys for a deviceId never change: a device with new keys registers a new
 * deviceId. That keeps safety codes stable and stops a silent key swap.
 */
const e2eeDeviceSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true },
    encPublicKey: { type: String, required: true },   // X25519
    signPublicKey: { type: String, required: true },  // Ed25519
    platform: { type: String, enum: ['android', 'ios', 'web', 'other'], default: 'other' },
    name: { type: String, maxlength: 60, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
}, { timestamps: true });

e2eeDeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
e2eeDeviceSchema.index({ userId: 1, revokedAt: 1 });

export default mongoose.model('E2eeDevice', e2eeDeviceSchema);
