import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Business from '../../src/models/business.models.js';
import { publicApiUrl, publicSiteUrl } from '../../src/utils/publicUrls.js';
import { kycCheck } from '../../src/utils/phase4.rules.js';
import {
    snapshotHash, signDetailsLink, readDetailsLink, decideDetailsLink, detailsLinkParams, DETAILS_LINK_MAX_AGE_MS,
} from '../../src/utils/detailsConfirmation.rules.js';
import { renderDetailsPage } from '../../src/utils/detailsConfirmation.page.js';
import {
    contactNoticeKind, contactRequestLookup, matchContactRequest, contactRequestView, contactRequestData, contactResponseData,
} from '../../src/utils/contactRequestNotice.rules.js';
import { MAX_PINNED_CHATS, pinnedAtFor, pinFieldsFor, sortChatsForUser } from '../../src/utils/chatPin.utils.js';
import {
    staleCallVerdict, staleCallClosure, busyMessage, RING_WINDOW_MS, JOIN_GRACE_MS, ALONE_GRACE_MS, UNKNOWN_ROOM_MAX_MS,
} from '../../src/utils/callLiveness.rules.js';

// Client bug list of 20 Nov 2026.

// ── Bug 1: the buttons in the business-details email ────────────────────────

test('bug 1: email links never point at the host that does not exist', () => {
    assert.equal(publicApiUrl('https://api.findernate.com'), 'https://apis.findernate.com');
    assert.equal(publicApiUrl('https://API.findernate.com/'), 'https://apis.findernate.com');
    assert.equal(publicApiUrl(''), 'https://apis.findernate.com');
    assert.equal(publicApiUrl(undefined), 'https://apis.findernate.com');
    assert.equal(publicApiUrl('FindeNate'), 'https://apis.findernate.com');
    assert.equal(publicApiUrl('ftp://apis.findernate.com'), 'https://apis.findernate.com');
    // A real address is used as it is (staging, a tunnel, a new domain).
    assert.equal(publicApiUrl('https://apis.findernate.com/'), 'https://apis.findernate.com');
    assert.equal(publicApiUrl('https://staging-api.example.com'), 'https://staging-api.example.com');
    assert.equal(publicApiUrl('http://localhost:4000'), 'http://localhost:4000');
    assert.equal(publicSiteUrl(''), 'https://findernate.com');
    assert.equal(publicSiteUrl('https://findernate.com/'), 'https://findernate.com');
});

const SECRET = 'test-secret';
const BUSINESS = '65f1a2b3c4d5e6f7a8b9c0d1';
const SNAP = { businessName: 'Sharma Stores', businessType: 'Retail', phone: '9876543210', address: 'MG Road, Pune' };

test('bug 1: a button of the email is read back and checked', () => {
    const sentAtMs = Date.now() - 60_000;
    const hash = snapshotHash(SNAP);
    const params = detailsLinkParams({ secret: SECRET, businessId: BUSINESS, action: 'confirm', sentAtMs, hash });
    assert.deepEqual(Object.keys(params), ['b', 'a', 's', 'h', 't']);

    const link = readDetailsLink(params, SECRET);
    assert.equal(link.ok, true);
    assert.equal(link.businessId, BUSINESS);
    assert.equal(link.action, 'confirm');
    assert.equal(link.sentAtMs, sentAtMs);
    assert.equal(link.hash, hash);

    // Survives the trip through a URL (what the browser really sends back).
    const viaUrl = Object.fromEntries(new URLSearchParams(new URLSearchParams(params).toString()));
    assert.equal(readDetailsLink(viaUrl, SECRET).ok, true);

    // Any change breaks the signature: the action, the fingerprint, the secret.
    assert.equal(readDetailsLink({ ...params, a: 'reject' }, SECRET).reason, 'bad_signature');
    assert.equal(readDetailsLink({ ...params, h: snapshotHash({ ...SNAP, phone: '1' }) }, SECRET).reason, 'bad_signature');
    assert.equal(readDetailsLink(params, 'other-secret').reason, 'bad_signature');
    // Junk is refused before any signature work.
    assert.equal(readDetailsLink({}, SECRET).reason, 'malformed');
    assert.equal(readDetailsLink({ ...params, b: 'nope' }, SECRET).reason, 'malformed');
    assert.equal(readDetailsLink({ ...params, a: 'delete' }, SECRET).reason, 'malformed');
    assert.equal(readDetailsLink({ ...params, t: 'x' }, SECRET).reason, 'malformed');
    assert.equal(readDetailsLink({ ...params, t: ['a', 'b'] }, SECRET).reason, 'malformed');
});

test('bug 1: emails sent before the fix (no fingerprint) are still accepted', () => {
    const sentAtMs = 1795000000000;
    // Exactly how the old code signed a button.
    const t = signDetailsLink({ secret: SECRET, businessId: BUSINESS, action: 'confirm', sentAtMs });
    const link = readDetailsLink({ b: BUSINESS, a: 'confirm', s: String(sentAtMs), t }, SECRET);
    assert.equal(link.ok, true);
    assert.equal(link.hash, null);
    const now = sentAtMs + 1000;
    // Good while it is the last email sent ...
    assert.equal(decideDetailsLink(link, { status: 'sent', latestSentAtMs: sentAtMs, currentHash: 'x' }, now), 'ask');
    // ... refused once a newer email replaced it.
    assert.equal(decideDetailsLink(link, { status: 'sent', latestSentAtMs: sentAtMs + 5000, currentHash: 'x' }, now), 'outdated');
});

test('bug 1: saving twice sends two emails and BOTH keep working', () => {
    const hash = snapshotHash(SNAP);
    const first = readDetailsLink(detailsLinkParams({ secret: SECRET, businessId: BUSINESS, action: 'confirm', sentAtMs: 1795000000000, hash }), SECRET);
    const second = readDetailsLink(detailsLinkParams({ secret: SECRET, businessId: BUSINESS, action: 'confirm', sentAtMs: 1795000002000, hash }), SECRET);
    const state = { locked: false, status: 'sent', latestSentAtMs: 1795000002000, currentHash: hash };
    const now = 1795000100000;
    assert.equal(decideDetailsLink(first, state, now), 'ask'); // used to answer "Link expired"
    assert.equal(decideDetailsLink(second, state, now), 'ask');
});

test('bug 1: what each button does in every state', () => {
    const hash = snapshotHash(SNAP);
    const sentAtMs = 1795000000000;
    const now = sentAtMs + 60_000;
    const link = (action) => readDetailsLink(detailsLinkParams({ secret: SECRET, businessId: BUSINESS, action, sentAtMs, hash }), SECRET);
    const base = { locked: false, status: 'sent', latestSentAtMs: sentAtMs, respondedAtMs: null, currentHash: hash };

    assert.equal(decideDetailsLink(link('confirm'), base, now), 'ask');
    assert.equal(decideDetailsLink(link('reject'), base, now), 'ask');

    // Pressed again after it worked: the same friendly answer, never an error.
    const confirmed = { ...base, locked: true, status: 'confirmed', respondedAtMs: now };
    assert.equal(decideDetailsLink(link('confirm'), confirmed, now + 1), 'already_confirmed');
    assert.equal(decideDetailsLink(link('reject'), confirmed, now + 1), 'confirmed_cannot_reject');

    const rejected = { ...base, status: 'rejected', respondedAtMs: now };
    assert.equal(decideDetailsLink(link('reject'), rejected, now + 1), 'already_rejected');
    // Changed their mind and the details are untouched: confirming is fine.
    assert.equal(decideDetailsLink(link('confirm'), rejected, now + 1), 'ask');

    // The owner edited the details after the email went out.
    const edited = { ...base, currentHash: snapshotHash({ ...SNAP, phone: '9000000000' }) };
    assert.equal(decideDetailsLink(link('confirm'), edited, now), 'outdated');
    assert.equal(decideDetailsLink(link('reject'), edited, now), 'outdated');

    assert.equal(decideDetailsLink(link('confirm'), base, sentAtMs + DETAILS_LINK_MAX_AGE_MS + 1), 'expired');
});

test('bug 1: the fingerprint ignores key order and treats missing as empty', () => {
    assert.equal(snapshotHash({ a: 1, b: null }), snapshotHash({ b: null, a: 1 }));
    assert.equal(snapshotHash({ a: 1, b: undefined }), snapshotHash({ a: 1, b: null }));
    assert.notEqual(snapshotHash({ a: 1 }), snapshotHash({ a: 2 }));
    assert.equal(snapshotHash(null), snapshotHash({}));
    assert.match(snapshotHash(SNAP), /^[a-f0-9]{16}$/);
});

test('bug 1: the page asks with a POST form and escapes what it shows', () => {
    const html = renderDetailsPage({
        title: 'Confirm your business details',
        message: 'Please check <the> details',
        rows: [['Business name', 'Tom & "Jerry" <script>alert(1)</script>']],
        form: { action: '/api/v1/kyc/business/confirm-details', fields: { b: BUSINESS, a: 'confirm', s: '1', t: 'abc"><x' }, label: 'Confirm details', kind: 'confirm' },
        secondary: { href: 'https://apis.findernate.com/x?a=reject&s=1', label: 'Something is wrong' },
        settingsUrl: 'https://findernate.com/settings/business',
    });
    assert.match(html, /<form method="post" action="\/api\/v1\/kyc\/business\/confirm-details">/);
    assert.match(html, /<input type="hidden" name="a" value="confirm">/);
    assert.match(html, /<button type="submit" class="btn btn-confirm">Confirm details<\/button>/);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('Tom &amp; &quot;Jerry&quot; &lt;script&gt;'));
    assert.ok(html.includes('value="abc&quot;&gt;&lt;x"'));
    assert.ok(html.includes('href="https://apis.findernate.com/x?a=reject&amp;s=1"'));
    assert.ok(html.includes('Please check &lt;the&gt; details'));
    // A result page has no form at all.
    assert.ok(!renderDetailsPage({ title: 'Details confirmed', message: 'Thank you', tone: 'success' }).includes('<form'));
});

test('bug 1: payment confirmations from Cashfree never go to the host that does not exist', async () => {
    const { readFile } = await import('node:fs/promises');
    const files = [
        'controllers/cashfree.payment.controller.js',
        'controllers/payments.controllers.js',
        'controllers/platformPayments.controllers.js',
        'controllers/subscription/payment.js',
    ];
    for (const file of files) {
        const source = await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /process\.env\.BACKEND_URL/, `${file} reads BACKEND_URL directly`);
        assert.match(source, /publicApiUrl\(\)/, `${file} does not use publicApiUrl()`);
        assert.doesNotMatch(source, /['"`]https:\/\/api\.findernate\.com/, `${file} names the dead host`);
    }
});

// ── Bug 2: "an error occurs" after the KYC OTP ──────────────────────────────

const stored = (kyc) => Business.hydrate({
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    businessName: 'Sharma Stores',
    ...(kyc === undefined ? {} : { kyc }),
});

const CASES = [
    ['a business that never started KYC', undefined],
    ['a business with a status only', { status: 'not_started' }],
    ['a business with other checks on record', { status: 'needs_review', checks: { pan: { valid: true, name: 'A SHARMA' }, gst: { valid: true, active: true } } }],
];

test('bug 2: the old way of saving a check is what failed', () => {
    // Kept as a record of the fault: rebuilding the checks from a spread of the
    // document's own value makes the untouched checks `undefined`.
    const business = stored({ status: 'not_started' });
    business.kyc.checks = { ...(business.kyc.checks || {}), aadhaar: { valid: true, name: 'A SHARMA', last4: '1234' } };
    const error = business.validateSync();
    assert.ok(error, 'expected the old pattern to fail validation');
    assert.match(error.message, /Cast to Object failed/);
});

for (const [label, kyc] of CASES) {
    test(`bug 2: the Aadhaar OTP result is kept for ${label}`, () => {
        const business = stored(kyc);
        business.set('kyc.checks.aadhaar', kycCheck({ valid: true, name: 'A SHARMA', last4: '1234', refId: '70471' }));
        assert.equal(business.validateSync(), undefined);
        const saved = business.toObject().kyc.checks;
        assert.equal(saved.aadhaar.valid, true);
        assert.equal(saved.aadhaar.name, 'A SHARMA');
        assert.equal(saved.aadhaar.last4, '1234');
        assert.ok(saved.aadhaar.checkedAt instanceof Date);
        // Whatever was on record is still there.
        if (kyc?.checks?.pan) assert.equal(saved.pan.name, 'A SHARMA');
        if (kyc?.checks?.gst) assert.equal(saved.gst.active, true);
        assert.ok(Object.keys(business.$__delta()[1].$set).includes('kyc.checks.aadhaar'));
    });

    test(`bug 2: submitting GST and PAN works for ${label}`, () => {
        const business = stored(kyc);
        const now = new Date();
        business.set('kyc.submittedAt', now);
        business.set('kyc.checks.gst', kycCheck({ available: true, valid: true, active: true, legalName: 'SHARMA STORES', tradeName: undefined, pan: 'AAPFU0939F', refId: '', message: 'ok' }, now));
        business.set('kyc.checks.pan', kycCheck({ available: true, valid: true, name: 'SHARMA STORES', pan: 'AAPFU0939F', refId: '9' }, now));
        business.set('kyc.status', 'verified');
        business.set('kyc.reasons', []);
        business.set('kyc.source', 'auto');
        business.set('kyc.verifiedAt', now);
        business.set('kyc.recheckDueAt', undefined);
        assert.equal(business.validateSync(), undefined);
        const saved = business.toObject().kyc;
        assert.equal(saved.status, 'verified');
        assert.equal(saved.checks.gst.legalName, 'SHARMA STORES');
        assert.equal(saved.checks.pan.pan, 'AAPFU0939F');
    });
}

test('bug 2: an older business row with values the schema now refuses can still submit KYC', () => {
    // Saved before today's rules: an empty bank account type and a retired plan name.
    const business = Business.hydrate({
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        businessName: 'Sharma Stores',
        plan: 'free',
        bankDetails: { accountType: '' },
        kyc: { checks: { aadhaar: { valid: true, name: 'A SHARMA', last4: '1234' } } },
    });
    // What submitBusinessKyc changes before it saves.
    business.registrationType = 'unregistered';
    business.panNumber = 'ABCDE1234F';
    business.set('kyc.submittedAt', new Date());
    business.set('kyc.status', 'needs_review');
    business.set('kyc.reasons', ['PAN and Aadhaar names do not match']);

    // Checking the whole row fails on fields the KYC never touched…
    const full = business.validateSync();
    assert.ok(full, 'expected the old row to fail a full validation');
    assert.deepEqual(Object.keys(full.errors).sort(), ['bankDetails.accountType', 'plan']);
    // …so the KYC save checks only what it changed.
    assert.equal(business.validateSync(undefined, { validateModifiedOnly: true }), undefined);
});

test('bug 2: the KYC submit saves with validateModifiedOnly', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/controllers/kyc.controllers.js', import.meta.url), 'utf8');
    const submit = source.slice(source.indexOf('export const submitBusinessKyc'), source.indexOf('export const businessAadhaarOtp'));
    assert.match(submit, /business\.save\(\{ validateModifiedOnly: true \}\)/);
    assert.doesNotMatch(submit, /business\.save\(\)/);
});

test('bug 2: a check keeps the outcome and names only', () => {
    const at = new Date('2026-11-20T00:00:00Z');
    assert.deepEqual(
        kycCheck({ available: true, valid: true, name: 'A', pan: 'AAPFU0939F', refId: '', message: 'ok', extra: 1 }, at),
        { checkedAt: at, valid: true, name: 'A', pan: 'AAPFU0939F' },
    );
    assert.deepEqual(kycCheck({ valid: false, name: null, last4: undefined }, at), { checkedAt: at, valid: false });
    assert.deepEqual(kycCheck(undefined, at), { checkedAt: at });
});

// ── Bug 6: Accept / Reject on the contact-request notification ──────────────

const OWNER = '65f1a2b3c4d5e6f7a8b9c0aa';
const ASKER = '65f1a2b3c4d5e6f7a8b9c0bb';
const REQUEST = '65f1a2b3c4d5e6f7a8b9c0cc';
const SHOP = '65f1a2b3c4d5e6f7a8b9c0dd';

test('bug 6: a new notification says which request it belongs to', () => {
    assert.deepEqual(contactRequestData({ requestId: REQUEST, businessId: SHOP }), { kind: 'contact_request', requestId: REQUEST, businessId: SHOP });
    assert.deepEqual(contactResponseData({ requestId: REQUEST, businessId: SHOP, status: 'approved' }), { kind: 'contact_request_response', requestId: REQUEST, businessId: SHOP, status: 'approved' });

    const notice = { type: 'others', senderId: ASKER, receiverId: OWNER, message: 'requested contact details for Sharma Stores', data: contactRequestData({ requestId: REQUEST, businessId: SHOP }) };
    assert.equal(contactNoticeKind(notice), 'request');
    assert.deepEqual(contactRequestLookup(notice), { kind: 'request', by: 'id', requestId: REQUEST });
});

test('bug 6: notifications stored before the fix are recognised by their sentence', () => {
    const request = { type: 'others', senderId: { _id: ASKER, username: 'asker' }, receiverId: OWNER, message: 'requested contact details for Sharma Stores' };
    assert.equal(contactNoticeKind(request), 'request');
    assert.deepEqual(contactRequestLookup(request), { kind: 'request', by: 'people', requester: ASKER, businessOwner: OWNER });
    assert.equal(contactNoticeKind({ type: 'others', message: 'requested your contact details' }), 'request');

    const answer = { type: 'others', senderId: OWNER, receiverId: ASKER, message: 'shared contact details for Sharma Stores: call me' };
    assert.equal(contactNoticeKind(answer), 'response');
    assert.deepEqual(contactRequestLookup(answer), { kind: 'response', by: 'people', requester: ASKER, businessOwner: OWNER });
    assert.equal(contactNoticeKind({ type: 'others', message: 'declined your contact request for the business' }), 'response');

    // Anything else is left alone.
    assert.equal(contactNoticeKind({ type: 'others', message: 'Your plan ends tomorrow' }), null);
    assert.equal(contactNoticeKind({ type: 'like', message: 'requested contact details for X' }), null);
    assert.equal(contactRequestLookup({ type: 'follow', message: 'started following you' }), null);
    // No sender to look up by.
    assert.equal(contactRequestLookup({ type: 'others', message: 'requested contact details for X', receiverId: OWNER }), null);
});

test('bug 6: the buttons show only while the request is waiting', () => {
    const requests = [
        { _id: REQUEST, requester: ASKER, businessOwner: OWNER, business: SHOP, status: 'pending', message: 'Please share your number', createdAt: new Date('2026-11-19T10:00:00Z') },
    ];
    const lookup = { kind: 'request', by: 'id', requestId: REQUEST };
    const view = contactRequestView('request', matchContactRequest(lookup, requests));
    assert.deepEqual(view, { kind: 'request', requestId: REQUEST, businessId: SHOP, status: 'pending', message: 'Please share your number', responseMessage: '', canRespond: true });

    requests[0].status = 'approved';
    assert.equal(contactRequestView('request', matchContactRequest(lookup, requests)).canRespond, false);
    // The person who asked can never answer their own request.
    assert.equal(contactRequestView('response', { ...requests[0], status: 'pending' }).canRespond, false);
    // A request that was deleted: nothing to show.
    assert.equal(contactRequestView('request', matchContactRequest({ kind: 'request', by: 'id', requestId: '65f1a2b3c4d5e6f7a8b9c0ff' }, requests)), null);
});

test('bug 6: with several businesses, the request made at that time is picked', () => {
    const requests = [
        { _id: '65f1a2b3c4d5e6f7a8b9c001', requester: ASKER, businessOwner: OWNER, business: '65f1a2b3c4d5e6f7a8b9c0e1', status: 'approved', createdAt: new Date('2026-11-01T10:00:00Z') },
        { _id: '65f1a2b3c4d5e6f7a8b9c002', requester: ASKER, businessOwner: OWNER, business: '65f1a2b3c4d5e6f7a8b9c0e2', status: 'pending', createdAt: new Date('2026-11-19T10:00:00Z') },
        { _id: '65f1a2b3c4d5e6f7a8b9c003', requester: OWNER, businessOwner: ASKER, business: '65f1a2b3c4d5e6f7a8b9c0e3', status: 'pending', createdAt: new Date('2026-11-19T10:00:00Z') },
    ];
    const lookup = { kind: 'request', by: 'people', requester: ASKER, businessOwner: OWNER };
    assert.equal(matchContactRequest(lookup, requests, new Date('2026-11-19T10:00:02Z'))._id, '65f1a2b3c4d5e6f7a8b9c002');
    assert.equal(matchContactRequest(lookup, requests, new Date('2026-11-01T10:00:02Z'))._id, '65f1a2b3c4d5e6f7a8b9c001');
});

// ── Pending: pin a chat ─────────────────────────────────────────────────────

test('pin: a pin belongs to the person who set it', () => {
    const at = new Date('2026-11-20T05:00:00Z');
    const chat = { pins: [{ userId: OWNER, pinnedAt: at }] };
    assert.deepEqual(pinFieldsFor(chat, OWNER), { isPinned: true, pinnedAt: at.toISOString() });
    assert.deepEqual(pinFieldsFor(chat, ASKER), { isPinned: false, pinnedAt: null });
    assert.deepEqual(pinFieldsFor({}, OWNER), { isPinned: false, pinnedAt: null });
    assert.equal(pinnedAtFor(null, OWNER), null);
    assert.equal(MAX_PINNED_CHATS, 3);
});

test('pin: pinned chats first, newest message first inside each group', () => {
    const chats = [
        { _id: 'old-unpinned', lastMessageAt: new Date('2026-11-01') },
        { _id: 'old-pinned', lastMessageAt: new Date('2026-10-01'), pins: [{ userId: OWNER, pinnedAt: new Date() }] },
        { _id: 'new-unpinned', lastMessageAt: new Date('2026-11-19') },
        { _id: 'new-pinned', lastMessageAt: new Date('2026-11-18'), pins: [{ userId: OWNER, pinnedAt: new Date() }] },
        { _id: 'pinned-by-someone-else', lastMessageAt: new Date('2026-11-10'), pins: [{ userId: ASKER, pinnedAt: new Date() }] },
    ];
    assert.deepEqual(sortChatsForUser(chats, OWNER).map((c) => c._id), ['new-pinned', 'old-pinned', 'new-unpinned', 'pinned-by-someone-else', 'old-unpinned']);
    assert.deepEqual(sortChatsForUser(chats, ASKER).map((c) => c._id), ['pinned-by-someone-else', 'new-unpinned', 'new-pinned', 'old-unpinned', 'old-pinned']);
    assert.equal(chats[0]._id, 'old-unpinned', 'the input is not reordered');
});

// ── Bug 7: the second call never rang ───────────────────────────────────────

test('bug 7: a call that rang out no longer keeps both people busy', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    const ringing = (secondsAgo) => ({ status: 'ringing', initiatedAt: new Date(now - secondsAgo * 1000) });
    assert.equal(staleCallVerdict(ringing(10), { now }), 'live');
    assert.equal(staleCallVerdict(ringing(RING_WINDOW_MS / 1000 + 1), { now }), 'missed');
    assert.equal(staleCallVerdict({ status: 'initiated', initiatedAt: new Date(now - 10 * 60 * 1000) }, { now }), 'missed');
});

test('bug 7: an answered call that nobody closed is released', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    const answered = (msAgo, status = 'connecting') => ({ status, initiatedAt: new Date(now - msAgo - 5000), startedAt: new Date(now - msAgo) });

    // Both people are in the room: a real call, however long.
    assert.equal(staleCallVerdict(answered(2 * 60 * 60 * 1000, 'active'), { now, room: { known: true, ended: false, participants: 2 } }), 'live');
    // The room was closed.
    assert.equal(staleCallVerdict(answered(30 * 1000), { now, room: { known: true, ended: true, participants: 0 } }), 'ended');
    // Just answered, nobody has joined yet: give them time.
    assert.equal(staleCallVerdict(answered(5 * 1000), { now, room: { known: true, ended: false, participants: 0 } }), 'live');
    // Nobody ever joined.
    assert.equal(staleCallVerdict(answered(JOIN_GRACE_MS + 1000), { now, room: { known: true, ended: false, participants: 0 } }), 'ended');
    // One person left alone (the other app was killed).
    assert.equal(staleCallVerdict(answered(60 * 1000), { now, room: { known: true, ended: false, participants: 1 } }), 'live');
    assert.equal(staleCallVerdict(answered(ALONE_GRACE_MS + 1000), { now, room: { known: true, ended: false, participants: 1 } }), 'ended');
    // The media service cannot be asked: never guess on a call of normal length.
    assert.equal(staleCallVerdict(answered(40 * 60 * 1000, 'active'), { now, room: { known: false } }), 'live');
    assert.equal(staleCallVerdict(answered(40 * 60 * 1000, 'active'), { now }), 'live');
    assert.equal(staleCallVerdict(answered(UNKNOWN_ROOM_MAX_MS + 1000, 'active'), { now, room: { known: false } }), 'ended');
    // A call that is already closed is not touched.
    assert.equal(staleCallVerdict({ status: 'ended', initiatedAt: new Date(0) }, { now }), 'live');
});

test('bug 7: how a released call is recorded', () => {
    const now = new Date('2026-11-20T10:00:00Z');
    assert.deepEqual(staleCallClosure({ status: 'ringing' }, 'missed', { now }), { status: 'missed', endedAt: now, endReason: 'timeout' });

    const startedAt = new Date('2026-11-20T09:00:00Z');
    const roomEndedAt = new Date('2026-11-20T09:04:30Z');
    // The room's own end time gives the real length ...
    assert.deepEqual(staleCallClosure({ startedAt }, 'ended', { now, roomEndedAt }), { status: 'ended', endedAt: roomEndedAt, endReason: 'network_error' });
    // ... and without it the call is not recorded as an hour long.
    assert.deepEqual(staleCallClosure({ startedAt }, 'ended', { now }), { status: 'ended', endedAt: startedAt, endReason: 'network_error' });
    assert.deepEqual(staleCallClosure({ startedAt }, 'ended', { now, roomEndedAt: new Date('2026-11-20T08:00:00Z') }).endedAt, startedAt);
});

test('bug 7: a really busy person gets a message the caller can read', () => {
    assert.equal(busyMessage({ callerBusy: true }), 'You are already in a call. End it before starting another one.');
    assert.equal(busyMessage({ callerBusy: false, receiverName: 'Vinayak' }), 'Vinayak is on another call. Please try again in a little while.');
    assert.match(busyMessage({ callerBusy: false }), /^This person is on another call/);
});
