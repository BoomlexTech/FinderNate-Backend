import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Admin } from '../../src/models/admin.models.js';
import {
    adminForgotPassword, adminResetPassword, hashResetToken, passwordProblem, resetLinkFor, RESET_TTL_MS, resetDeps,
} from '../../src/controllers/admin/passwordReset.controllers.js';

resetDeps.clearFailedLogins = async () => {};

// The admin panel had no way back in after a forgotten password.

afterEach(() => mock.restoreAll());

const chain = (value) => ({ select: () => chain(value), lean: async () => value, then: (res, rej) => Promise.resolve(value).then(res, rej) });

const run = (handler, body) => new Promise((resolve) => {
    const res = {
        statusCode: 0,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, payload }); return this; },
    };
    handler({ body }, res, (err) => resolve({ error: err }));
});

const TOKEN = 'a'.repeat(64);

const adminDoc = (over = {}) => {
    const doc = {
        _id: 'admin1',
        email: 'support@findernate.com',
        fullName: 'Support',
        isActive: true,
        password: 'old-hash',
        refreshToken: 'r',
        passwordResetTokenHash: hashResetToken(TOKEN),
        passwordResetExpires: new Date(Date.now() + RESET_TTL_MS),
        saved: 0,
        async save() { this.saved++; return this; },
        ...over,
    };
    return doc;
};

test('passwordProblem: length, letters and a number', () => {
    assert.match(passwordProblem('short1'), /at least 8/);
    assert.match(passwordProblem('onlyletters'), /letters and at least one number/);
    assert.match(passwordProblem('12345678'), /letters and at least one number/);
    assert.equal(passwordProblem('QwFind2026x'), null);
});

test('resetLinkFor: points at the website admin reset page', () => {
    const link = resetLinkFor('a+b@findernate.com', TOKEN);
    assert.match(link, /\/admin\/reset-password\?email=a%2Bb%40findernate\.com&token=a{64}$/);
});

test('forgot-password: same answer whether or not the email is an admin', async () => {
    mock.method(Admin, 'findOne', () => chain(null));
    const out = await run(adminForgotPassword, { email: 'nobody@example.com' });
    assert.equal(out.status, 200);
    assert.match(out.payload.message, /If that email belongs to an admin/);
});

test('forgot-password: a second request within a minute sends nothing new', async () => {
    const doc = adminDoc({ passwordResetRequestedAt: new Date() });
    mock.method(Admin, 'findOne', () => chain(doc));
    const out = await run(adminForgotPassword, { email: doc.email });
    assert.equal(out.status, 200);
    assert.equal(doc.saved, 0);
});

test('reset-password: right token → new password, link used up, signed out everywhere', async () => {
    const doc = adminDoc();
    mock.method(Admin, 'findOne', () => chain(doc));
    const out = await run(adminResetPassword, { email: doc.email, token: TOKEN, password: 'NewPass2026' });
    assert.equal(out.status, 200);
    assert.equal(doc.password, 'NewPass2026'); // hashed by the model on save
    assert.equal(doc.passwordResetTokenHash, undefined);
    assert.equal(doc.passwordResetExpires, undefined);
    assert.equal(doc.refreshToken, undefined);
    assert.equal(doc.saved, 1);
});

test('reset-password: wrong or expired token, or a weak password, is refused', async () => {
    const doc = adminDoc();
    mock.method(Admin, 'findOne', () => chain(doc));
    const wrong = await run(adminResetPassword, { email: doc.email, token: 'b'.repeat(64), password: 'NewPass2026' });
    assert.equal(wrong.error?.statusCode, 400);

    const expired = adminDoc({ passwordResetExpires: new Date(Date.now() - 1000) });
    mock.restoreAll();
    mock.method(Admin, 'findOne', () => chain(expired));
    const late = await run(adminResetPassword, { email: expired.email, token: TOKEN, password: 'NewPass2026' });
    assert.equal(late.error?.statusCode, 400);

    const weak = await run(adminResetPassword, { email: doc.email, token: TOKEN, password: 'short' });
    assert.equal(weak.error?.statusCode, 400);
    assert.equal(doc.saved, 0);
});
