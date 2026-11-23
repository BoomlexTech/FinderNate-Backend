import test from 'node:test';
import assert from 'node:assert/strict';
import { exactIdSearchClauses, maskBusinessIdsForAdmin, maskGstin, stripKycForPublic } from '../../src/utils/businessPrivacy.utils.js';

// A business record after Phase 4 KYC, as Mongo hands it back (made-up IDs).
const business = () => ({
    _id: 'b1',
    businessName: 'Sharp Kraft',
    gstNumber: '29ABCDE1234F1Z5',
    panNumber: 'ABCDE1234F',
    verificationRemarks: 'names differ',
    kyc: {
        status: 'needs_review',
        reasons: ['PAN and Aadhaar names do not match'],
        checks: {
            gst: { valid: true, legalName: 'SHARP KRAFT', pan: 'ABCDE1234F' },
            pan: { valid: true, name: 'RAVI KUMAR', pan: 'ABCDE1234F' },
            aadhaar: { valid: true, name: 'RAVI K', last4: '9012' },
        },
    },
    detailsConfirmation: { status: 'sent', snapshot: { phone: '9999999999', email: 'owner@example.com', address: '1 Main St' } },
    contact: { website: 'https://example.com' },
});

test('admins see the PAN as its last four characters, everywhere it is stored', () => {
    const masked = maskBusinessIdsForAdmin(business());
    assert.equal(masked.panNumber, '••••••234F');
    assert.equal(masked.kyc.checks.pan.pan, '••••••234F');
    assert.equal(masked.kyc.checks.gst.pan, '••••••234F');
    assert.doesNotMatch(JSON.stringify(masked), /ABCDE1234F/, 'no full PAN anywhere in what is sent');
    // What the admin still needs to judge a check stays.
    assert.equal(masked.kyc.checks.pan.name, 'RAVI KUMAR');
    assert.equal(masked.kyc.checks.gst.legalName, 'SHARP KRAFT');
    assert.equal(masked.kyc.status, 'needs_review');
    // Characters 3–12 of a GSTIN are the PAN: masked the same way.
    assert.equal(masked.gstNumber, '29••••••234F1Z5');
});

test('the e-mailed details copy reaches the admin masked too', () => {
    const b = business();
    b.detailsConfirmation.snapshot = { ...b.detailsConfirmation.snapshot, gstNumber: '29ABCDE1234F1Z5', panNumber: '••••••234F' };
    const masked = maskBusinessIdsForAdmin(b);
    assert.equal(masked.detailsConfirmation.snapshot.gstNumber, '29••••••234F1Z5');
    assert.equal(masked.detailsConfirmation.snapshot.panNumber, '••••••234F');
    assert.equal(masked.detailsConfirmation.status, 'sent');
    assert.doesNotMatch(JSON.stringify(masked), /ABCDE1234F/);
    assert.equal(b.detailsConfirmation.snapshot.gstNumber, '29ABCDE1234F1Z5', 'stored copy unchanged');
});

test('maskGstin keeps the state code, the PAN\'s last four and the tail', () => {
    assert.equal(maskGstin('29abcde1234f1z5'), '29••••••234F1Z5');
    assert.equal(maskGstin(''), '');
    assert.equal(maskGstin('SHORT12'), '•••RT12');
});

test('masking does not change the stored record', () => {
    const original = business();
    maskBusinessIdsForAdmin(original);
    assert.equal(original.panNumber, 'ABCDE1234F');
    assert.equal(original.kyc.checks.pan.pan, 'ABCDE1234F');
});

test('works on a Mongoose document, and on records without KYC', () => {
    const doc = { toObject: () => business() };
    assert.equal(maskBusinessIdsForAdmin(doc).panNumber, '••••••234F');
    assert.deepEqual(maskBusinessIdsForAdmin({ businessName: 'x' }), { businessName: 'x' });
    assert.equal(maskBusinessIdsForAdmin(null), null);
});

test('a stranger gets no PAN, no check results, no e-mailed details, no admin remarks', () => {
    // As in stripPrivateBusinessFields, which has already dropped the GSTIN
    // (characters 3–12 of a GSTIN are the PAN).
    const input = { ...business() };
    delete input.gstNumber;
    const out = stripKycForPublic(input);
    assert.equal(out.panNumber, undefined);
    assert.equal(out.detailsConfirmation, undefined);
    assert.equal(out.verificationRemarks, undefined);
    assert.deepEqual(out.kyc, { status: 'needs_review' }, 'only the status stays');
    const json = JSON.stringify(out);
    for (const secret of ['ABCDE1234F', 'RAVI', '9012', 'owner@example.com', '9999999999']) {
        assert.ok(!json.includes(secret), `leaks ${secret}`);
    }
    assert.equal(out.businessName, 'Sharp Kraft');
    assert.deepEqual(out.contact, { website: 'https://example.com' });
});

test('admins see the legacy Aadhaar number as its last four digits', () => {
    const masked = maskBusinessIdsForAdmin({ ...business(), aadhaarNumber: '123456789012' });
    assert.equal(masked.aadhaarNumber, '••••••••9012');
    assert.equal(maskBusinessIdsForAdmin({ aadhaarNumber: '1234 5678 9012' }).aadhaarNumber, '••••••••9012', 'spaced too');
    assert.doesNotMatch(JSON.stringify(masked), /12345678/);
    // An aggregate row (history page): a plain object with only some fields.
    assert.deepEqual(
        maskBusinessIdsForAdmin({ businessName: 'x', aadhaarNumber: '123456789012', verificationStatus: 'approved' }),
        { businessName: 'x', aadhaarNumber: '••••••••9012', verificationStatus: 'approved' },
    );
});

test('admin search matches masked ID numbers only when typed in full', () => {
    assert.deepEqual(exactIdSearchClauses('1234 5678 9012'), [{ aadhaarNumber: { $in: ['123456789012', '1234 5678 9012'] } }]);
    assert.deepEqual(exactIdSearchClauses('29abcde1234f1z5'), [{ gstNumber: { $regex: '^29ABCDE1234F1Z5$', $options: 'i' } }]);
    // Partial numbers, names and regex tricks never reach the ID fields.
    for (const q of ['4', '1234', '12345678901', '29ABCDE', '.*', '^1', 'Sharp Kraft', '', undefined, null]) {
        assert.deepEqual(exactIdSearchClauses(q), [], `"${q}" must not search ID numbers`);
    }
});
