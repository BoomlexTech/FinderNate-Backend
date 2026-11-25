import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    KYC_VERIFIED_NOTICE, KYC_DETAILS_CONFIRMED_NOTICE, currentKycNotice, withCurrentKycWording,
} from '../../src/utils/kycNotices.js';

// Client, 25 Nov 2026: the "verified" notice congratulates, and no notice
// talks about re-verification (that is offered in business settings, under the
// locked fields).

const OLD_VERIFIED = 'Your business is verified. Your product, service and business posts can now be seen by your followers, and by everyone with an active plan.';
const OLD_CONFIRMED = 'Your business details are confirmed. They can no longer be edited without re-verification.';

test('the verified notice congratulates', () => {
    assert.equal(KYC_VERIFIED_NOTICE, 'Congratulations! Your business account is verified.');
});

test('no verification notice mentions re-verification', () => {
    for (const text of [KYC_VERIFIED_NOTICE, KYC_DETAILS_CONFIRMED_NOTICE]) {
        assert.doesNotMatch(text, /re-?verif/i);
        assert.doesNotMatch(text, /no longer be edited/i);
    }
});

test('notices already sent are shown with the new wording', () => {
    assert.equal(currentKycNotice(OLD_VERIFIED), KYC_VERIFIED_NOTICE);
    assert.equal(currentKycNotice(OLD_CONFIRMED), KYC_DETAILS_CONFIRMED_NOTICE);
    // Anything else is left exactly as stored.
    const other = "We're checking your business details. This usually takes a working day.";
    assert.equal(currentKycNotice(other), other);
    assert.equal(currentKycNotice(undefined), undefined);
});

test('only verification notices in a page are touched', () => {
    const page = [
        { type: 'kyc', message: OLD_VERIFIED },
        { type: 'kyc', message: OLD_CONFIRMED },
        { type: 'kyc', message: 'Re-verification paid. You can now edit your business details and submit them again.' },
        // The same words under another type are somebody's own text.
        { type: 'comment', message: OLD_VERIFIED },
        { type: 'like' },
    ];
    withCurrentKycWording(page);
    assert.equal(page[0].message, KYC_VERIFIED_NOTICE);
    assert.equal(page[1].message, KYC_DETAILS_CONFIRMED_NOTICE);
    assert.match(page[2].message, /^Re-verification paid/);
    assert.equal(page[3].message, OLD_VERIFIED);
    assert.equal(page[4].message, undefined);
});

test('the controllers send and show the shared wording', async () => {
    const read = (path) => readFile(new URL(`../../src/controllers/${path}`, import.meta.url), 'utf8');
    const kyc = await read('kyc.controllers.js');
    assert.match(kyc, /\? KYC_VERIFIED_NOTICE/);
    assert.match(kyc, /await notify\(KYC_DETAILS_CONFIRMED_NOTICE\)/);
    assert.doesNotMatch(kyc, /notify\('[^']*re-verification/);
    const list = await read('notification.controllers.js');
    assert.match(list, /withCurrentKycWording\(notifications\);/);
});
