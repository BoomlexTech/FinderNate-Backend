import test from 'node:test';
import assert from 'node:assert/strict';
import {
    visibilityTier, canSeeCommercial, effectiveKycStatus, premiumFirst, isValidGstin, isValidPan, panFromGstin,
    nameMatchScore, decideKyc, lockedFieldsTouched, withGst, adPrice, isB2B, commissionFor, adStatusAt, pickAds,
    validateAdCta, listingChecks, shouldNotifyInstantly, istDay, expiryLabel, daysLeft, slugify,
} from '../../src/utils/phase4.rules.js';

test('§5.1 visibility tiers', () => {
    assert.equal(visibilityTier({ kycStatus: 'pending', plan: 'plan3', subscriptionStatus: 'active' }), 'hidden');
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan1', subscriptionStatus: 'active' }), 'network');
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan2', subscriptionStatus: 'inactive' }), 'network');
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan2', subscriptionStatus: 'active' }), 'public');
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan3', subscriptionStatus: 'active' }), 'premium');
    assert.ok(canSeeCommercial('hidden', { isOwner: true }));
    assert.ok(!canSeeCommercial('hidden', { isConnected: true }));
    assert.ok(canSeeCommercial('network', { isConnected: true }));
    assert.ok(!canSeeCommercial('network', {}));
    assert.ok(canSeeCommercial('premium', {}));
});

test('Q10 businesses approved before Phase 4 count as verified until the recheck deadline', () => {
    assert.equal(effectiveKycStatus({ verificationStatus: 'approved' }), 'verified');
    assert.equal(effectiveKycStatus({ verificationStatus: 'pending' }), 'not_started');
    const past = new Date(Date.now() - 1000);
    assert.equal(effectiveKycStatus({ kyc: { status: 'verified', source: 'legacy_admin', recheckDueAt: past } }), 'recheck_overdue');
    assert.equal(effectiveKycStatus({ kyc: { status: 'verified', source: 'auto' } }), 'verified');
});

test('#78 Premium first, order kept otherwise', () => {
    const out = premiumFirst([{ id: 1 }, { id: 2, p: 1 }, { id: 3 }, { id: 4, p: 1 }], (x) => !!x.p);
    assert.deepEqual(out.map((x) => x.id), [2, 4, 1, 3]);
});

test('#30 GSTIN and PAN checks', () => {
    assert.ok(isValidGstin('27AAPFU0939F1ZV'));
    assert.ok(!isValidGstin('27AAPFU0939F1ZX'));
    assert.ok(!isValidGstin('27AAPFU0939F1Z'));
    assert.equal(panFromGstin('27AAPFU0939F1ZV'), 'AAPFU0939F');
    assert.ok(isValidPan('aapfu0939f'));
    assert.ok(!isValidPan('AAPF0939F'));
});

test('#30 name matching ignores Pvt Ltd and M/s', () => {
    assert.equal(nameMatchScore('M/s Asha Foods Pvt. Ltd.', 'Asha Foods'), 100);
    assert.ok(nameMatchScore('Asha Foods', 'Ravi Electronics') < 50);
    assert.equal(nameMatchScore('', 'x'), 0);
});

test('#30 decisions: a clean pass verifies, anything else goes to review', () => {
    const ok = decideKyc({
        registrationType: 'registered', businessName: 'Asha Foods',
        gst: { valid: true, active: true, legalName: 'ASHA FOODS PRIVATE LIMITED', pan: 'AAPFU0939F' },
        pan: { valid: true, name: 'Asha Foods Pvt Ltd', pan: 'AAPFU0939F' },
    });
    assert.equal(ok.status, 'verified');
    const bad = decideKyc({
        registrationType: 'registered', businessName: 'Totally Different',
        gst: { valid: true, active: false, legalName: 'ASHA FOODS', pan: 'AAPFU0939F' },
        pan: { valid: true, name: 'Asha Foods', pan: 'AAPFU0939F' },
    });
    assert.equal(bad.status, 'needs_review');
    assert.ok(bad.reasons.length >= 2);
    const unreg = decideKyc({ registrationType: 'unregistered', pan: { valid: true, name: 'Ravi Kumar' }, aadhaar: { valid: true, name: 'RAVI KUMAR' } });
    assert.equal(unreg.status, 'verified');
});

test('#4 locked fields', () => {
    assert.deepEqual(lockedFieldsTouched({ description: 'x' }), []);
    assert.deepEqual(lockedFieldsTouched({ businessName: 'x', location: { city: 'Pune' } }), ['businessName', 'location.city']);
});

test('money: GST, ads, B2B commission', () => {
    assert.deepEqual(withGst(100, 18), { amount: 100, gst: 18, total: 118, gstPercent: 18 });
    assert.equal(adPrice(7, 100, 18).total, 826);
    assert.ok(isB2B('verified', 'verified'));
    assert.ok(!isB2B('verified', 'pending'));
    assert.deepEqual(commissionFor(1000, { b2b: true }), { rate: 0.1, commission: 100, sellerNet: 900 });
    assert.equal(commissionFor(1000, { b2b: false }).commission, 25);
});

test('#27 ad lifecycle, rotation and calls to action', () => {
    const now = new Date('2026-11-04T10:00:00Z');
    assert.equal(adStatusAt({ status: 'scheduled', startAt: '2026-11-05', endAt: '2026-11-06' }, now), 'scheduled');
    assert.equal(adStatusAt({ status: 'scheduled', startAt: '2026-11-03', endAt: '2026-11-06' }, now), 'running');
    assert.equal(adStatusAt({ status: 'running', startAt: '2026-11-01', endAt: '2026-11-02' }, now), 'completed');
    const ads = [{ _id: 'a', stats: { impressions: 50 } }, { _id: 'b', stats: { impressions: 0 } }, { _id: 'c', stats: { impressions: 5 } }];
    assert.deepEqual(pickAds(ads, { count: 2, random: () => 0 }).map((a) => a._id), ['b', 'c']);
    assert.deepEqual(pickAds(ads, { count: 3, seenToday: { b: 3 }, cap: 3, random: () => 0 }).map((a) => a._id), ['c', 'a']);
    assert.equal(validateAdCta('contact', { whatsapp: '+919876543210' }), null);
    assert.ok(validateAdCta('website', { url: 'nope' }));
    assert.equal(validateAdCta('app', { playStoreUrl: 'https://play.google.com/store/apps/details?id=x' }), null);
});

test('#80 listing checks', () => {
    const good = { contentType: 'product', media: [{ url: 'x' }], customization: { product: { name: 'Steel bottle', price: 299 } } };
    assert.deepEqual(listingChecks(good), []);
    const bad = { contentType: 'product', media: [], customization: { product: { name: 'Call 9876543210 cheap ganja', price: 0 } } };
    const flags = listingChecks(bad);
    assert.ok(flags.includes('Missing price'));
    assert.ok(flags.includes('No photo or video'));
    assert.ok(flags.includes('Possibly prohibited item'));
    assert.ok(flags.includes('Contact details in the title'));
});

test('#75 and #77 helpers', () => {
    assert.ok(shouldNotifyInstantly(2, 3));
    assert.ok(!shouldNotifyInstantly(3, 3));
    assert.equal(istDay(new Date('2026-11-04T20:00:00Z')), '2026-11-05');
    const now = new Date('2026-11-04T00:00:00Z');
    assert.equal(expiryLabel(new Date('2026-11-19T00:00:00Z'), now), 'Expires in 15 days');
    assert.match(expiryLabel(new Date('2027-01-22T00:00:00Z'), now), /^Valid until 22 Jan 2027$/);
    assert.equal(daysLeft(new Date('2026-11-05T00:00:00Z'), now), 1);
    assert.equal(slugify('Steel Water Bottle – 1L!'), 'steel-water-bottle-1l');
});
