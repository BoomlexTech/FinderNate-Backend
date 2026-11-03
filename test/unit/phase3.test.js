import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
    ROLES, roleOf, effectiveOwnerId, checkGroupPermission, nextOwnerAfterLeave, bySeniority,
    systemMessageText, parseDisappearingSeconds, expiryFor, viewOnceAllowed, redactViewOnce, previewLabel,
} from '../../src/utils/chatRoles.rules.js';
import {
    normalizeEnvelope, missingDevices, pruneEnvelopeKeys, validateDeviceKeys, validateBackup,
} from '../../src/utils/e2ee.rules.js';
import { normalizeGif } from '../../src/utils/giphy.rules.js';

const O = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const A = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const B = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const M = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const X = 'aaaaaaaaaaaaaaaaaaaaaaa5';

const group = (extra = {}) => ({
    chatType: 'group',
    participants: [O, A, B, M],
    admins: [O, A, B],
    createdBy: O,
    ownerId: O,
    memberSince: [
        { userId: O, joinedAt: new Date('2025-01-01') },
        { userId: A, joinedAt: new Date('2025-02-01') },
        { userId: B, joinedAt: new Date('2025-01-15') },
        { userId: M, joinedAt: new Date('2025-01-02') },
    ],
    ...extra,
});

test('#21 roles: owner, admin, member, outsider', () => {
    const g = group();
    assert.equal(roleOf(g, O), ROLES.OWNER);
    assert.equal(roleOf(g, A), ROLES.ADMIN);
    assert.equal(roleOf(g, M), ROLES.MEMBER);
    assert.equal(roleOf(g, X), null);
});

test('#21 permission table from the plan', () => {
    const g = group();
    // Add members: owner and admins
    assert.equal(checkGroupPermission(g, O, 'add_members'), null);
    assert.equal(checkGroupPermission(g, A, 'add_members'), null);
    assert.ok(checkGroupPermission(g, M, 'add_members'));
    // Remove members: owner and admins
    assert.equal(checkGroupPermission(g, A, 'remove_member', M), null);
    assert.ok(checkGroupPermission(g, M, 'remove_member', A));
    // Remove admins: owner only
    assert.equal(checkGroupPermission(g, O, 'remove_member', A), null);
    assert.ok(checkGroupPermission(g, A, 'remove_member', B));
    assert.ok(checkGroupPermission(g, A, 'block_member', B));
    // Make or remove admins: owner only
    assert.equal(checkGroupPermission(g, O, 'make_admin', M), null);
    assert.ok(checkGroupPermission(g, A, 'make_admin', M));
    assert.equal(checkGroupPermission(g, O, 'remove_admin', A), null);
    assert.ok(checkGroupPermission(g, O, 'remove_admin', M));
    // Nobody removes the owner
    assert.ok(checkGroupPermission(g, A, 'remove_member', O));
    assert.ok(checkGroupPermission(g, O, 'remove_member', O));
    // Delete: owner only
    assert.equal(checkGroupPermission(g, O, 'delete_group'), null);
    assert.ok(checkGroupPermission(g, A, 'delete_group'));
    // Direct chats have no group permissions
    assert.ok(checkGroupPermission({ chatType: 'direct', participants: [O, A] }, O, 'add_members'));
});

test('#21 older groups: owner falls back to creator, then longest-serving admin', () => {
    assert.equal(effectiveOwnerId(group({ ownerId: undefined })), O);
    // Creator left (allowed before Phase 3): the longest-serving admin owns it.
    const left = group({ ownerId: undefined, participants: [A, B, M], admins: [A, B] });
    assert.equal(effectiveOwnerId(left), B);
    // No join records: participants order decides.
    const legacy = { chatType: 'group', participants: [M, A], admins: [], createdBy: O };
    assert.equal(effectiveOwnerId(legacy), M);
});

test('#21 owner leaves: longest-serving admin, else longest-serving member', () => {
    assert.equal(nextOwnerAfterLeave(group(), O), B);
    assert.equal(nextOwnerAfterLeave(group({ admins: [O] }), O), M);
    assert.equal(nextOwnerAfterLeave({ chatType: 'group', participants: [O], admins: [O] }, O), null);
    assert.deepEqual(bySeniority(group(), [A, M, B]), [M, B, A]);
});

test('#21 system message text', () => {
    const asha = { fullName: 'Asha' };
    assert.equal(systemMessageText('admin_added', asha, [{ username: 'ravi' }]), 'Asha made ravi an admin');
    assert.equal(systemMessageText('members_added', asha, [{ fullName: 'A' }, { fullName: 'B' }, { fullName: 'C' }]), 'Asha added A, B and 1 more');
    assert.match(systemMessageText('disappearing_on', asha, [], { seconds: 604800 }), /7 days/);
});

test('#37 disappearing: accepted values and expiry', () => {
    assert.equal(parseDisappearingSeconds('7d'), 604800);
    assert.equal(parseDisappearingSeconds(86400), 86400);
    assert.equal(parseDisappearingSeconds('off'), 0);
    assert.equal(parseDisappearingSeconds(3600), null);
    const sent = new Date('2026-01-01T00:00:00Z');
    const chat = { disappearing: { seconds: 86400 } };
    assert.equal(expiryFor(chat, 'text', sent).toISOString(), '2026-01-02T00:00:00.000Z');
    // Money, orders, calls and system notices never disappear.
    assert.equal(expiryFor(chat, 'checkout', sent), null);
    assert.equal(expiryFor(chat, 'system', sent), null);
    assert.equal(expiryFor({ disappearing: { seconds: 0 } }, 'text', sent), null);
});

test('#48 view-once: DMs only, photos and videos; link never in lists', () => {
    assert.ok(viewOnceAllowed({ chatType: 'direct' }, 'image'));
    assert.ok(viewOnceAllowed({ chatType: 'direct' }, 'encrypted'));
    assert.ok(!viewOnceAllowed({ chatType: 'group' }, 'image'));
    assert.ok(!viewOnceAllowed({ chatType: 'direct' }, 'text'));

    const msg = { sender: O, viewOnce: true, mediaUrl: 'https://cdn/x.jpg', e2ee: { v: 1 }, viewOnceOpenedBy: [] };
    const forRecipient = redactViewOnce(msg, A);
    assert.equal(forRecipient.mediaUrl, null);
    assert.equal(forRecipient.e2ee, undefined);
    assert.equal(forRecipient.viewOnceState, 'ready');
    assert.equal(redactViewOnce(msg, O).viewOnceState, 'sent');
    const opened = { ...msg, viewOnceOpenedBy: [{ userId: A }] };
    assert.equal(redactViewOnce(opened, A).viewOnceState, 'opened');
    assert.equal(redactViewOnce(opened, O).viewOnceState, 'opened');
    assert.equal(previewLabel('video', { viewOnce: true }), '📹 View-once video');
});

const b64 = (n, fill = 1) => Buffer.alloc(n, fill).toString('base64');

const envelope = (keys) => ({
    v: 1,
    senderDeviceId: 'dev-sender-1',
    ephemeralPublicKey: b64(32),
    nonce: b64(24),
    ciphertext: b64(40),
    signature: b64(64),
    keys,
});

test('#2 e2ee: envelope shape is checked and whitelisted', () => {
    const key = (deviceId) => ({ deviceId, nonce: b64(24), wrappedKey: b64(48), extra: 'dropped' });
    const { envelope: e, error } = normalizeEnvelope(envelope([key('dev-a-0001'), key('dev-a-0001'), key('dev-b-0001')]));
    assert.equal(error, undefined);
    assert.equal(e.keys.length, 2);
    assert.equal(e.keys[0].extra, undefined);
    assert.ok(normalizeEnvelope({ ...envelope([key('dev-a-0001')]), nonce: b64(12) }).error);
    assert.ok(normalizeEnvelope({ ...envelope([]) }).error);
    assert.ok(normalizeEnvelope('not json').error);
});

test('#2 e2ee: every device must be covered; stale wraps are dropped', () => {
    const key = (deviceId) => ({ deviceId, nonce: b64(24), wrappedKey: b64(48) });
    const { envelope: e } = normalizeEnvelope(envelope([key('dev-a-0001'), key('dev-old-001')]));
    const devices = [{ userId: A, deviceId: 'dev-a-0001' }, { userId: B, deviceId: 'dev-b-0001' }];
    assert.deepEqual(missingDevices(e, devices).map((d) => d.deviceId), ['dev-b-0001']);
    const pruned = pruneEnvelopeKeys(e, devices);
    assert.deepEqual(pruned.keys.map((k) => [k.deviceId, k.userId]), [['dev-a-0001', A]]);
});

test('#2 e2ee: device keys and backup validation', () => {
    assert.equal(validateDeviceKeys({ deviceId: 'web-12345678', encPublicKey: b64(32), signPublicKey: b64(32) }), null);
    assert.ok(validateDeviceKeys({ deviceId: 'x', encPublicKey: b64(32), signPublicKey: b64(32) }));
    assert.ok(validateDeviceKeys({ deviceId: 'web-12345678', encPublicKey: b64(31), signPublicKey: b64(32) }));
    const ok = { kdf: { alg: 'pbkdf2-sha256', iterations: 200000, salt: b64(16) }, nonce: b64(24), ciphertext: b64(100) };
    assert.equal(validateBackup(ok), null);
    assert.ok(validateBackup({ ...ok, kdf: { ...ok.kdf, iterations: 1000 } }));
});

test('#2 e2ee: the wrap construction works end to end with standard primitives', async () => {
    // The clients use X25519 + SHA-256 + XChaCha20-Poly1305. Node has no
    // XChaCha, so this checks the key agreement and derivation half, which is
    // where the website and the app must agree byte for byte.
    const { subtle } = webcrypto;
    const gen = () => subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const eph = await gen();
    const dev = await gen();
    const raw = async (k) => new Uint8Array(await subtle.exportKey('raw', k));
    const ephPub = await raw(eph.publicKey);
    const devPub = await raw(dev.publicKey);
    const s1 = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: dev.publicKey }, eph.privateKey, 256));
    const s2 = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: eph.publicKey }, dev.privateKey, 256));
    assert.deepEqual(s1, s2);
    const label = new TextEncoder().encode('findernate-e2ee-wrap-v1');
    const kdf = async (s) => new Uint8Array(await subtle.digest('SHA-256', Buffer.concat([label, s, ephPub, devPub])));
    assert.deepEqual(await kdf(s1), await kdf(s2));
});

test('#7 GIPHY items are reduced to https links', () => {
    const g = normalizeGif({
        id: 'abc123',
        title: 'Hello',
        images: {
            fixed_height: { webp: 'https://media.giphy.com/a.webp?cid=1', mp4: 'https://media.giphy.com/a.mp4', width: '200', height: '150' },
            fixed_height_small: { webp: 'https://media.giphy.com/s.webp' },
        },
    }, 'stickers');
    assert.equal(g.url, 'https://media.giphy.com/a.webp');
    assert.equal(g.type, 'sticker');
    assert.equal(g.previewUrl, 'https://media.giphy.com/s.webp');
    assert.equal(g.width, 200);
    assert.equal(normalizeGif({ id: 'x', images: { fixed_height: { url: 'http://insecure/a.gif' } } }), null);
});
