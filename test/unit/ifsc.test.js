import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { verifyIfsc } from '../../src/services/cashfreeVerify.service.js';
import { checkIfscOnSave } from '../../src/utils/ifsc.utils.js';

// Fake credentials: every call below goes to a mocked axios, never to Cashfree.
const setEnv = (env = 'sandbox') => {
    process.env.CASHFREE_VERIFY_CLIENT_ID = 'test-client-id';
    process.env.CASHFREE_VERIFY_CLIENT_SECRET = 'test-client-secret';
    process.env.CASHFREE_VERIFY_ENV = env;
};
const clearEnv = () => {
    delete process.env.CASHFREE_VERIFY_CLIENT_ID;
    delete process.env.CASHFREE_VERIFY_CLIENT_SECRET;
    delete process.env.CASHFREE_VERIFY_ENV;
};

const VALID_BODY = {
    verification_id: 'x', reference_id: 123, status: 'VALID', bank: 'HDFC BANK', ifsc: 'HDFC0000001',
    branch: 'BANGALORE - RAJA RAJESHWARI NAGAR BRANCH', city: 'BANGALORE', state: 'KARNATAKA',
    address: 'GROUND FLOOR, 123, ABC CIRCLE', micr: 560751026,
};

test('a real IFSC comes back valid with its bank and branch', async (t) => {
    setEnv();
    t.after(clearEnv);
    const calls = [];
    t.mock.method(axios, 'post', async (url, body, cfg) => { calls.push({ url, body, cfg }); return { status: 200, data: VALID_BODY }; });

    const r = await verifyIfsc(' hdfc0000001 ');
    assert.equal(r.outcome, 'valid');
    assert.equal(r.valid, true);
    assert.equal(r.bank, 'HDFC BANK');
    assert.equal(r.branch, 'BANGALORE - RAJA RAJESHWARI NAGAR BRANCH');
    assert.equal(r.city, 'BANGALORE');
    assert.equal(r.refId, '123');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://sandbox.cashfree.com/verification/ifsc');
    assert.equal(calls[0].body.ifsc, 'HDFC0000001', 'trimmed and upper-cased');
    assert.match(calls[0].body.verification_id, /^[A-Za-z0-9._-]{1,50}$/, 'a verification id Cashfree accepts');
    assert.equal(calls[0].cfg.headers['x-client-id'], 'test-client-id');
    assert.equal(calls[0].cfg.headers['x-client-secret'], 'test-client-secret');
});

test('every lookup uses its own verification id', async (t) => {
    setEnv();
    t.after(clearEnv);
    const ids = [];
    t.mock.method(axios, 'post', async (_u, body) => { ids.push(body.verification_id); return { status: 200, data: VALID_BODY }; });
    await verifyIfsc('HDFC0000001');
    await verifyIfsc('HDFC0000001');
    assert.notEqual(ids[0], ids[1]);
});

test('production credentials use the production address', async (t) => {
    setEnv('production');
    t.after(clearEnv);
    let url;
    t.mock.method(axios, 'post', async (u) => { url = u; return { status: 200, data: VALID_BODY }; });
    await verifyIfsc('HDFC0000001');
    assert.equal(url, 'https://api.cashfree.com/verification/ifsc');
});

test('a code Cashfree cannot find is invalid, with words a seller can act on', async (t) => {
    setEnv();
    t.after(clearEnv);
    t.mock.method(axios, 'post', async () => ({ status: 404, data: { type: 'not_found_error', code: 'ifsc_not_found', message: 'IFSC not found. Please try again with valid IFSC' } }));
    const r = await verifyIfsc('HDFC0999999');
    assert.equal(r.outcome, 'invalid');
    assert.equal(r.valid, false);
    assert.match(r.message, /could not find this IFSC/i);
});

test('a malformed code in Cashfree\'s own format is invalid; one with letters at the end is only "could not check"', async (t) => {
    setEnv();
    t.after(clearEnv);
    t.mock.method(axios, 'post', async () => ({ status: 400, data: { type: 'validation_error', code: 'ifsc_value_invalid', message: 'ifsc should be valid.' } }));

    const digits = await verifyIfsc('HDFC0123456');
    assert.equal(digits.outcome, 'invalid');

    // Some cooperative and rural banks have letters in the last six characters.
    // Cashfree's format check rejects them, which must not lock those sellers out.
    const letters = await verifyIfsc('HDFC0RRBKGB');
    assert.equal(letters.outcome, 'unavailable');
});

test('when Cashfree cannot answer, the result is "unavailable" and nothing throws', async (t) => {
    setEnv();
    t.after(clearEnv);
    t.mock.method(console, 'warn', () => {});
    const cases = [
        [401, { type: 'authentication_error', code: 'authentication_failed', message: 'Invalid clientId and clientSecret combination' }],
        [403, { type: 'authentication_error', code: 'ip_validation_failed', message: 'IP not whitelisted' }],
        [422, { type: 'validation_error', code: 'insufficient_balance', message: 'Insufficient balance to process this request' }],
        [429, { type: 'rate_limit_error', code: 'too_many_requests_per_ip', message: 'Too many requests' }],
        [409, { type: 'validation_error', code: 'verification_id_already_exists', message: 'verification ID already exists' }],
        [200, { status: 'SOMETHING_NEW' }],
    ];
    for (const [status, data] of cases) {
        const m = t.mock.method(axios, 'post', async () => ({ status, data }));
        const r = await verifyIfsc('HDFC0000001');
        assert.equal(r.outcome, 'unavailable', `HTTP ${status}`);
        assert.notEqual(r.valid, true);
        m.mock.restore();
    }
});

test('a timeout or a Cashfree outage is "unavailable", not an error', async (t) => {
    setEnv();
    t.after(clearEnv);
    t.mock.method(console, 'warn', () => {});
    t.mock.method(axios, 'post', async () => { const e = new Error('timeout of 20000ms exceeded'); e.code = 'ECONNABORTED'; throw e; });
    const r = await verifyIfsc('HDFC0000001');
    assert.equal(r.outcome, 'unavailable');
});

test('without credentials nothing is called', async (t) => {
    clearEnv();
    const m = t.mock.method(axios, 'post', async () => ({ status: 200, data: VALID_BODY }));
    const r = await verifyIfsc('HDFC0000001');
    assert.equal(r.available, false);
    assert.equal(r.outcome, 'unavailable');
    assert.equal(m.mock.callCount(), 0);
});

test('saving bank details: an unchanged IFSC is not looked up again', async () => {
    let called = 0;
    const verify = async () => { called++; return { available: true, outcome: 'valid' }; };
    const r = await checkIfscOnSave({ ifsc: 'hdfc0000001', previousIfsc: 'HDFC0000001', verify });
    assert.deepEqual(r, { checked: false });
    assert.equal(called, 0, 'no credit spent');
});

test('saving bank details: a new IFSC is checked and its branch is offered', async () => {
    const verify = async (code) => ({ available: true, outcome: 'valid', bank: 'HDFC BANK', branch: `Branch of ${code}` });
    const r = await checkIfscOnSave({ ifsc: 'hdfc0000001', previousIfsc: 'ICIC0000001', verify });
    assert.deepEqual(r, { checked: true, valid: true, bank: 'HDFC BANK', branch: 'Branch of HDFC0000001' });
});

test('saving bank details: an IFSC that does not exist is refused', async () => {
    const verify = async () => ({ available: true, outcome: 'invalid', message: 'We could not find this IFSC code. Check it and try again.' });
    const r = await checkIfscOnSave({ ifsc: 'HDFC0999999', previousIfsc: undefined, verify });
    assert.equal(r.checked, true);
    assert.equal(r.valid, false);
    assert.match(r.message, /could not find/);
});

test('saving bank details: if Cashfree cannot answer, the seller is not blocked', async () => {
    for (const result of [
        { available: false, outcome: 'unavailable' },
        { available: true, outcome: 'unavailable', code: 'insufficient_balance' },
        undefined,
    ]) {
        const r = await checkIfscOnSave({ ifsc: 'HDFC0000001', previousIfsc: undefined, verify: async () => result });
        assert.deepEqual(r, { checked: false });
    }
});

test('saving bank details: a blank IFSC is not looked up', async () => {
    let called = 0;
    const r = await checkIfscOnSave({ ifsc: '  ', previousIfsc: undefined, verify: async () => { called++; return {}; } });
    assert.deepEqual(r, { checked: false });
    assert.equal(called, 0);
});
