import Chat from '../models/chat.models.js';
import E2eeDevice from '../models/e2eeDevice.models.js';
import { ApiError } from './ApiError.js';
import { normalizeEnvelope, missingDevices, pruneEnvelopeKeys } from './e2ee.rules.js';
import { postSystemMessage } from './chatSystem.utils.js';

/** Active (not revoked) devices of these users, public keys included. */
export const activeDevicesOf = async (userIds) =>
    E2eeDevice.find({ userId: { $in: userIds }, revokedAt: null })
        .select('userId deviceId encPublicKey signPublicKey platform name lastSeenAt')
        .lean();

/**
 * Checks an encrypted message before it's stored (Phase 3 #2). End-to-end
 * encryption starts with one-to-one chats, so groups are refused for now.
 * Throws 409 E2EE_DEVICES_CHANGED, with the current devices, when the
 * envelope misses a device, so the sender can fetch keys and try again.
 */
export const prepareEncryptedMessage = async (chat, senderId, rawEnvelope) => {
    if (chat.chatType !== 'direct') {
        throw new ApiError(400, 'End-to-end encryption is available in one-to-one chats for now');
    }
    const { error, envelope } = normalizeEnvelope(rawEnvelope);
    if (error) throw new ApiError(400, error);

    const devices = await activeDevicesOf(chat.participants);
    const sender = devices.find((d) => d.deviceId === envelope.senderDeviceId && String(d.userId) === String(senderId));
    if (!sender) throw new ApiError(400, 'This device is not registered for encryption. Register its keys first.');

    const missing = missingDevices(envelope, devices);
    if (missing.length) {
        const err = new ApiError(409, 'Someone in this chat added a device. Fetch their keys and send again.');
        err.data = { code: 'E2EE_DEVICES_CHANGED', devices: devices.map(publicDevice) };
        throw err;
    }
    return pruneEnvelopeKeys(envelope, devices);
};

/** Turns on the chat's E2EE flag and posts the system notice, once. */
export const markChatEncrypted = async (chat, actorId) => {
    const res = await Chat.updateOne(
        { _id: chat._id, 'e2ee.enabled': { $ne: true } },
        { $set: { 'e2ee.enabled': true, 'e2ee.since': new Date() } }
    );
    if (res.modifiedCount) {
        chat.e2ee = { enabled: true, since: new Date() };
        await postSystemMessage(chat, 'e2ee_on', { actorId });
    }
};

export const publicDevice = (d) => ({
    userId: String(d.userId),
    deviceId: d.deviceId,
    encPublicKey: d.encPublicKey,
    signPublicKey: d.signPublicKey,
    platform: d.platform,
    name: d.name || '',
});
