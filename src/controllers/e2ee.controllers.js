import mongoose from 'mongoose';
import E2eeDevice from '../models/e2eeDevice.models.js';
import E2eeBackup from '../models/e2eeBackup.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { uploadBufferToBunny } from '../utils/bunny.js';
import { CHAT_MEDIA_LIMITS_MB } from '../constants/uploadLimits.js';
import { validateDeviceKeys, validateBackup, MAX_DEVICES_PER_USER } from '../utils/e2ee.rules.js';
import { activeDevicesOf, publicDevice } from '../utils/e2ee.utils.js';
import { getBlockedParticipantIds } from './chat/helpers.js';
import socketManager from '../config/socket.js';

const PLATFORMS = ['android', 'ios', 'web', 'other'];

/**
 * PUT /e2ee/devices/:deviceId  { encPublicKey, signPublicKey, platform, name }
 *
 * Registers this phone or browser's public keys (Phase 3 #2). Safe to call on
 * every start. Keys for a deviceId can't change; a device with new keys must
 * use a new deviceId (409 otherwise), so nobody's keys are swapped silently.
 */
export const registerE2eeDevice = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const deviceId = req.params.deviceId;
    const { encPublicKey, signPublicKey } = req.body || {};
    const invalid = validateDeviceKeys({ deviceId, encPublicKey, signPublicKey });
    if (invalid) throw new ApiError(400, invalid);

    const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : 'other';
    const name = String(req.body?.name || '').slice(0, 60);

    const existing = await E2eeDevice.findOne({ userId, deviceId });
    if (existing) {
        if (existing.encPublicKey !== encPublicKey || existing.signPublicKey !== signPublicKey) {
            throw new ApiError(409, 'This device already has different keys. Register under a new deviceId.');
        }
        if (existing.revokedAt) throw new ApiError(410, 'This device was signed out of encryption. Register under a new deviceId.');
        existing.lastSeenAt = new Date();
        if (name) existing.name = name;
        await existing.save();
        return res.status(200).json(new ApiResponse(200, publicDevice(existing), 'Device keys up to date'));
    }

    const active = await E2eeDevice.countDocuments({ userId, revokedAt: null });
    if (active >= MAX_DEVICES_PER_USER) {
        // Make room by retiring the device that's been quiet the longest.
        const oldest = await E2eeDevice.findOne({ userId, revokedAt: null }).sort({ lastSeenAt: 1 });
        if (oldest) {
            oldest.revokedAt = new Date();
            await oldest.save();
        }
    }

    const device = await E2eeDevice.create({ userId, deviceId, encPublicKey, signPublicKey, platform, name });

    // People chatting with this user should re-fetch keys before the next send.
    if (socketManager.isReady()) socketManager.emitToUser(String(userId), 'e2ee_devices_changed', { userId: String(userId) });

    return res.status(201).json(new ApiResponse(201, publicDevice(device), 'Device registered for encryption'));
});

/** GET /e2ee/devices — the caller's own devices. */
export const listMyE2eeDevices = asyncHandler(async (req, res) => {
    const devices = await E2eeDevice.find({ userId: req.user._id, revokedAt: null })
        .sort({ lastSeenAt: -1 })
        .lean();
    return res.status(200).json(new ApiResponse(200, {
        devices: devices.map((d) => ({ ...publicDevice(d), lastSeenAt: d.lastSeenAt, createdAt: d.createdAt })),
    }, 'OK'));
});

/** DELETE /e2ee/devices/:deviceId — sign a device out of encryption (e.g. on sign-out). */
export const revokeE2eeDevice = asyncHandler(async (req, res) => {
    const result = await E2eeDevice.updateOne(
        { userId: req.user._id, deviceId: req.params.deviceId, revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );
    return res.status(200).json(new ApiResponse(200, { revoked: result.modifiedCount > 0 }, 'Device removed'));
});

/**
 * GET /e2ee/keys?userIds=a,b — public keys of these users' devices.
 * `enabled` is true when a user has at least one device, which is what turns
 * encryption on for a one-to-one chat.
 */
export const getE2eeKeys = asyncHandler(async (req, res) => {
    const raw = String(req.query.userIds || req.query.userId || '').split(',').map((s) => s.trim());
    const ids = [...new Set(raw)].filter((id) => mongoose.Types.ObjectId.isValid(id)).slice(0, 20);
    if (!ids.length) throw new ApiError(400, 'userIds is required');

    const blocked = await getBlockedParticipantIds(req.user._id, ids);
    const allowed = ids.filter((id) => !blocked.has(id) || id === String(req.user._id));
    const devices = await activeDevicesOf(allowed);

    const users = {};
    for (const id of ids) users[id] = { enabled: false, devices: [] };
    for (const d of devices) {
        const k = String(d.userId);
        users[k].devices.push(publicDevice(d));
        users[k].enabled = true;
    }
    return res.status(200).json(new ApiResponse(200, { users }, 'OK'));
});

/**
 * POST /e2ee/blobs (multipart `file`) — stores an already-encrypted
 * attachment byte for byte. The server can't see what's inside.
 */
export const uploadE2eeBlob = asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new ApiError(400, 'file is required');
    const limitMB = Math.max(...Object.values(CHAT_MEDIA_LIMITS_MB));
    if (file.size > limitMB * 1024 * 1024) {
        throw new ApiError(413, `Encrypted attachments can be up to ${limitMB} MB`);
    }
    const uploaded = await uploadBufferToBunny(file.buffer, 'chat_e2ee', 'blob.bin', 'application/octet-stream');
    return res.status(201).json(new ApiResponse(201, { url: uploaded.secure_url, size: file.size }, 'Uploaded'));
});

/** GET /e2ee/backup — the caller's encrypted key backup, if any. */
export const getE2eeBackup = asyncHandler(async (req, res) => {
    const backup = await E2eeBackup.findOne({ userId: req.user._id }).lean();
    if (!backup) return res.status(200).json(new ApiResponse(200, { exists: false }, 'No backup'));
    return res.status(200).json(new ApiResponse(200, {
        exists: true,
        kdf: backup.kdf,
        nonce: backup.nonce,
        ciphertext: backup.ciphertext,
        version: backup.version,
        deviceCount: backup.deviceCount,
        updatedAt: backup.updatedAt,
    }, 'OK'));
});

/**
 * PUT /e2ee/backup  { kdf: { alg, iterations, salt }, nonce, ciphertext,
 * deviceCount, expectedVersion? }
 * Saves the PIN-encrypted key backup. `expectedVersion` stops one device from
 * overwriting a newer backup it hasn't seen (409).
 */
export const putE2eeBackup = asyncHandler(async (req, res) => {
    const invalid = validateBackup(req.body);
    if (invalid) throw new ApiError(400, invalid);
    const { kdf, nonce, ciphertext } = req.body;
    const deviceCount = Math.max(0, Math.min(Number(req.body.deviceCount) || 0, 100));
    const expected = req.body.expectedVersion;

    const current = await E2eeBackup.findOne({ userId: req.user._id });
    if (current && expected !== undefined && Number(expected) !== current.version) {
        const err = new ApiError(409, 'Your backup was changed on another device. Load it and try again.');
        err.data = { version: current.version };
        throw err;
    }

    const doc = current || new E2eeBackup({ userId: req.user._id, version: 0 });
    doc.kdf = { alg: kdf.alg, iterations: Number(kdf.iterations), salt: kdf.salt };
    doc.nonce = nonce;
    doc.ciphertext = ciphertext;
    doc.deviceCount = deviceCount;
    doc.version = (doc.version || 0) + 1;
    await doc.save();

    return res.status(200).json(new ApiResponse(200, { version: doc.version, updatedAt: doc.updatedAt }, 'Backup saved'));
});

/** DELETE /e2ee/backup — turns the backup off. */
export const deleteE2eeBackup = asyncHandler(async (req, res) => {
    await E2eeBackup.deleteOne({ userId: req.user._id });
    return res.status(200).json(new ApiResponse(200, { deleted: true }, 'Backup deleted'));
});
