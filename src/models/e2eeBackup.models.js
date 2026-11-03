import mongoose from 'mongoose';

/**
 * A user's encrypted key backup (Phase 3 #2). The device encrypts its private
 * keys with a key derived from the user's backup PIN; a new device downloads
 * this and, with the PIN, can read older messages. The server stores only the
 * encrypted blob and never sees the PIN.
 */
const e2eeBackupSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    kdf: {
        alg: { type: String, default: 'pbkdf2-sha256' },
        iterations: Number,
        salt: String,
    },
    nonce: String,
    ciphertext: String,
    // Bumped on every save so two devices can't overwrite each other blindly.
    version: { type: Number, default: 1 },
    deviceCount: { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model('E2eeBackup', e2eeBackupSchema);
