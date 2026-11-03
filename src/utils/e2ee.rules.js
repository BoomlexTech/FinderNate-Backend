/**
 * End-to-end encryption (#2, #40): server-side shape checks only.
 *
 * The server never sees keys or plaintext. It stores public keys, forwards
 * encrypted envelopes, and checks that an envelope is well formed and covers
 * every device that should be able to read it. The cryptography itself runs
 * on the devices (libsodium on the website, the `cryptography` package in the
 * app):
 *
 *  - Each device has an X25519 key pair (encryption) and an Ed25519 key pair
 *    (signing).
 *  - A message is encrypted once with a random 32-byte content key using
 *    XChaCha20-Poly1305 (IETF). The content key is then wrapped for every
 *    reading device: X25519(ephemeral, device) → SHA-256(label ‖ shared ‖
 *    ephemeralPub ‖ devicePub) → XChaCha20-Poly1305.
 *  - The sender signs (ciphertext ‖ nonce ‖ ephemeralPub ‖ chatId) with its
 *    Ed25519 key, so a recipient can tell the server didn't forge it.
 */

export const E2EE_VERSION = 1;
export const E2EE_ALG = 'x25519-xchacha20poly1305-v1';
export const MAX_DEVICES_PER_USER = 10;
export const MAX_CIPHERTEXT_B64 = 96 * 1024; // the text payload; media goes in encrypted blobs
export const MAX_BACKUP_B64 = 256 * 1024;

const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export const isB64 = (s, { min = 1, max = Infinity } = {}) =>
    typeof s === 'string' && s.length >= min && s.length <= max && B64.test(s);

/** Decoded length of a base64 (or base64url) string. */
export const b64Bytes = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;

/** Exactly `n` bytes once decoded. */
export const isBytes = (s, n) => isB64(s, { min: Math.floor((n * 4) / 3), max: Math.ceil(n / 3) * 4 }) && b64Bytes(s) === n;

export const isKey32 = (s) => isBytes(s, 32);

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Validates a device registration body. Returns an error message or null. */
export const validateDeviceKeys = ({ deviceId, encPublicKey, signPublicKey } = {}) => {
    if (!DEVICE_ID_RE.test(String(deviceId || ''))) return 'deviceId must be 8–64 letters, digits, - or _';
    if (!isKey32(encPublicKey)) return 'encPublicKey must be a base64 X25519 public key';
    if (!isKey32(signPublicKey)) return 'signPublicKey must be a base64 Ed25519 public key';
    return null;
};

/**
 * Validates and whitelists an encrypted envelope. Returns
 * `{ error }` or `{ envelope }`.
 */
export const normalizeEnvelope = (raw) => {
    let e = raw;
    if (typeof e === 'string') {
        try { e = JSON.parse(e); } catch { return { error: 'e2ee must be a JSON object' }; }
    }
    if (!e || typeof e !== 'object') return { error: 'e2ee is required for encrypted messages' };
    if (Number(e.v) !== E2EE_VERSION) return { error: 'Unsupported e2ee version' };
    if (!DEVICE_ID_RE.test(String(e.senderDeviceId || ''))) return { error: 'e2ee.senderDeviceId is invalid' };
    if (!isKey32(e.ephemeralPublicKey)) return { error: 'e2ee.ephemeralPublicKey is invalid' };
    if (!isBytes(e.nonce, 24)) return { error: 'e2ee.nonce must be 24 bytes' };
    if (!isB64(e.ciphertext, { min: 22, max: MAX_CIPHERTEXT_B64 })) return { error: 'e2ee.ciphertext is missing or too large' };
    if (!isBytes(e.signature, 64)) return { error: 'e2ee.signature must be 64 bytes' };
    if (!Array.isArray(e.keys) || e.keys.length === 0) return { error: 'e2ee.keys is required' };
    if (e.keys.length > MAX_DEVICES_PER_USER * 2 + 2) return { error: 'Too many device keys' };

    const keys = [];
    const seen = new Set();
    for (const k of e.keys) {
        if (!k || !DEVICE_ID_RE.test(String(k.deviceId || ''))) return { error: 'e2ee.keys[].deviceId is invalid' };
        if (!isBytes(k.nonce, 24)) return { error: 'e2ee.keys[].nonce must be 24 bytes' };
        // 32-byte key + 16-byte tag.
        if (!isBytes(k.wrappedKey, 48)) return { error: 'e2ee.keys[].wrappedKey is invalid' };
        const key = `${k.userId || ''}:${k.deviceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ userId: k.userId ? String(k.userId) : undefined, deviceId: String(k.deviceId), nonce: k.nonce, wrappedKey: k.wrappedKey });
    }

    return {
        envelope: {
            v: E2EE_VERSION,
            alg: E2EE_ALG,
            senderDeviceId: String(e.senderDeviceId),
            ephemeralPublicKey: e.ephemeralPublicKey,
            nonce: e.nonce,
            ciphertext: e.ciphertext,
            signature: e.signature,
            keys,
        },
    };
};

/**
 * Every active device of every participant must be able to read the message,
 * or a new phone silently misses it. Returns the devices the envelope is
 * missing (empty when it covers everyone). Keys for devices that no longer
 * exist are harmless and ignored.
 *
 * @param envelope   normalized envelope
 * @param devices    [{ userId, deviceId }] active devices of all participants
 */
export const missingDevices = (envelope, devices) => {
    const have = new Set((envelope?.keys || []).map((k) => k.deviceId));
    return (devices || []).filter((d) => !have.has(String(d.deviceId)));
};

/** Drops wraps for devices that are no longer registered, and stamps userId. */
export const pruneEnvelopeKeys = (envelope, devices) => {
    const byId = new Map((devices || []).map((d) => [String(d.deviceId), String(d.userId)]));
    return {
        ...envelope,
        keys: (envelope.keys || [])
            .filter((k) => byId.has(k.deviceId))
            .map((k) => ({ ...k, userId: byId.get(k.deviceId) })),
    };
};

/** Validates a PIN-encrypted key backup. Returns an error message or null. */
export const validateBackup = (b) => {
    if (!b || typeof b !== 'object') return 'Backup body is required';
    const kdf = b.kdf || {};
    if (!['pbkdf2-sha256'].includes(kdf.alg)) return 'kdf.alg must be pbkdf2-sha256';
    const it = Number(kdf.iterations);
    if (!Number.isInteger(it) || it < 100000 || it > 5000000) return 'kdf.iterations must be between 100,000 and 5,000,000';
    if (!isB64(kdf.salt, { min: 22, max: 44 })) return 'kdf.salt must be 16–32 bytes';
    if (!isBytes(b.nonce, 24)) return 'nonce must be 24 bytes';
    if (!isB64(b.ciphertext, { min: 22, max: MAX_BACKUP_B64 })) return 'ciphertext is missing or too large';
    return null;
};
