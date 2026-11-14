import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProtocol, isWebLink, normalizeSocialLinks } from '../../src/utils/socialLinks.utils.js';

test('withProtocol adds https:// to a bare address', () => {
    assert.equal(withProtocol('mybusiness.com'), 'https://mybusiness.com');
    assert.equal(withProtocol('  www.site.in/about '), 'https://www.site.in/about');
    assert.equal(withProtocol('//cdn.site.in/x'), 'https://cdn.site.in/x');
    assert.equal(withProtocol('http://old.site'), 'http://old.site');
    assert.equal(withProtocol('HTTPS://Upper.site'), 'HTTPS://Upper.site');
    assert.equal(withProtocol(''), '');
    assert.equal(withProtocol('   '), '');
});

test('isWebLink accepts real web addresses only', () => {
    assert.ok(isWebLink('https://mybusiness.com'));
    assert.ok(isWebLink('https://instagram.com/me?x=1'));
    assert.ok(!isWebLink('https://localhost'));
    assert.ok(!isWebLink('https://my business.com'));
    assert.ok(!isWebLink('mybusiness.com'));
});

test('social links without a protocol are fixed, not rejected', () => {
    const out = normalizeSocialLinks([{ platform: 'Instagram', url: 'instagram.com/me' }, { platform: 'x', url: '' }]);
    assert.deepEqual(out, [{ platform: 'instagram', url: 'https://instagram.com/me' }]);
    assert.throws(() => normalizeSocialLinks([{ platform: 'facebook', url: 'not a link' }]), /doesn't look like a web address/);
});
