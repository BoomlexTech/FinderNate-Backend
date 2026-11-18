import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_SETTING_KEYS, DEFAULT_LISTING_FEES, DEFAULT_E2EE_INDICATOR } from '../../src/constants/settings.js';
import { validateSettingValue } from '../../src/controllers/admin/settings.helpers.js';

// The admin settings API refused every key it did not list, so the listing
// fees (client item #21) and other prices could not be set from admin.

test('settings: prices and switches the code reads can be saved from admin', () => {
    for (const key of ['LISTING_FEE_30', 'LISTING_FEE_60', 'PLUS_PLAN_PRICE', 'AD_DAILY_FEE', 'ADS_ENABLED', 'E2EE_INDICATOR']) {
        assert.ok(ALLOWED_SETTING_KEYS.includes(key), key);
    }
});

test('settings: rupee prices take non-negative numbers, switches take true/false', () => {
    assert.equal(validateSettingValue('LISTING_FEE_30', 99).valid, true);
    assert.equal(validateSettingValue('LISTING_FEE_30', -1).valid, false);
    assert.equal(validateSettingValue('LISTING_FEE_60', '149').valid, false);
    assert.equal(validateSettingValue('E2EE_INDICATOR', false).valid, true);
    assert.equal(validateSettingValue('E2EE_INDICATOR', 'yes').valid, false);
    assert.equal(validateSettingValue('ADS_ENABLED', true).valid, true);
});

test('settings: listings are on with default fees until admin sets them', () => {
    assert.deepEqual({ ...DEFAULT_LISTING_FEES }, { 30: 99, 60: 149 });
    assert.equal(DEFAULT_E2EE_INDICATOR, true);
});
