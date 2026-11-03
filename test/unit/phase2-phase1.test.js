/**
 * Unit tests for the Phase 2 / Phase 1 rules that live in dependency-free
 * modules (no database, Redis or network needed).
 *
 *   npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isPostInteractionAllowed, assertPostInteractionAllowed, interactionSettingsOf } from '../../src/utils/postInteraction.utils.js';
import { MUTE_DURATIONS, muteStateFor, isChatMutedFor, muteFieldsFor } from '../../src/utils/chatMute.utils.js';
import { scrubHiddenLocation, scrubHiddenLocations, publicUserPopulate, visibleLocationClauses } from '../../src/utils/profilePrivacy.utils.js';
import { normalizeSocialLinks, SOCIAL_LINK_LIMIT } from '../../src/utils/socialLinks.utils.js';

const AUTHOR = '64b000000000000000000001';
const VIEWER = '64b000000000000000000002';

describe('#18 per-post like / comment / share switches', () => {
    test('posts created before the switches existed allow everything', () => {
        const post = { userId: AUTHOR, settings: {} };
        for (const kind of ['like', 'comment', 'share']) {
            assert.equal(isPostInteractionAllowed(post, VIEWER, kind), true);
        }
        assert.deepEqual(interactionSettingsOf(post), { allowLikes: true, allowComments: true, allowShares: true });
    });

    test('an explicit false blocks other users', () => {
        const post = { userId: AUTHOR, settings: { allowLikes: false, allowComments: false, allowShares: false } };
        for (const kind of ['like', 'comment', 'share']) {
            assert.equal(isPostInteractionAllowed(post, VIEWER, kind), false);
        }
        assert.deepEqual(interactionSettingsOf(post), { allowLikes: false, allowComments: false, allowShares: false });
    });

    test('the author is never blocked by their own switches', () => {
        const post = { userId: AUTHOR, settings: { allowComments: false } };
        assert.equal(isPostInteractionAllowed(post, AUTHOR, 'comment'), true);
        // populated author
        assert.equal(isPostInteractionAllowed({ ...post, userId: { _id: AUTHOR } }, AUTHOR, 'comment'), true);
    });

    test('assert throws 403 INTERACTION_DISABLED with a readable message', () => {
        const post = { userId: AUTHOR, settings: { allowLikes: false } };
        assert.throws(() => assertPostInteractionAllowed(post, VIEWER, 'like'), (err) => {
            assert.equal(err.statusCode, 403);
            assert.equal(err.message, 'Likes are turned off for this post');
            assert.equal(err.errors[0].code, 'INTERACTION_DISABLED');
            return true;
        });
        assert.doesNotThrow(() => assertPostInteractionAllowed(post, VIEWER, 'comment'));
    });
});

describe('#38 chat mute', () => {
    const now = new Date('2026-11-03T10:00:00Z');

    test('not muted without an entry', () => {
        assert.equal(isChatMutedFor({ mutes: [] }, VIEWER, now), false);
        assert.deepEqual(muteFieldsFor({}, VIEWER, now), { isMuted: false, mutedUntil: null });
    });

    test('until null means muted until turned off', () => {
        const chat = { mutes: [{ userId: VIEWER, until: null }] };
        assert.equal(muteStateFor(chat, VIEWER, now), null);
        assert.deepEqual(muteFieldsFor(chat, VIEWER, now), { isMuted: true, mutedUntil: null });
    });

    test('a timed mute ends by itself', () => {
        const chat = { mutes: [{ userId: VIEWER, until: new Date('2026-11-03T18:00:00Z') }] };
        assert.deepEqual(muteFieldsFor(chat, VIEWER, now), { isMuted: true, mutedUntil: '2026-11-03T18:00:00.000Z' });
        assert.equal(isChatMutedFor(chat, VIEWER, new Date('2026-11-03T18:00:01Z')), false);
    });

    test('mutes are per user', () => {
        const chat = { mutes: [{ userId: VIEWER, until: null }] };
        assert.equal(isChatMutedFor(chat, AUTHOR, now), false);
    });

    test('the legacy mutedBy list still counts as muted', () => {
        assert.equal(isChatMutedFor({ mutedBy: [VIEWER] }, VIEWER, now), true);
    });

    test('durations offered to clients', () => {
        assert.deepEqual(Object.keys(MUTE_DURATIONS), ['8h', '1w', 'always']);
        assert.equal(MUTE_DURATIONS.always, null);
    });
});

describe('#12 hidden location', () => {
    test('scrubs location and address only when hidden', () => {
        const hidden = scrubHiddenLocation({ location: 'Pune', address: 'MG Road', isAddressHidden: true });
        assert.equal(hidden.location, null);
        assert.equal(hidden.address, null);
        const shown = scrubHiddenLocation({ location: 'Pune', isAddressHidden: false });
        assert.equal(shown.location, 'Pune');
        assert.equal(scrubHiddenLocation(null), null);
    });

    test('array form and populate options', () => {
        const users = scrubHiddenLocations([{ location: 'A', isAddressHidden: true }, { location: 'B' }]);
        assert.deepEqual(users.map((u) => u.location), [null, 'B']);
        const opts = publicUserPopulate('userId', 'username location');
        assert.equal(opts.path, 'userId');
        assert.equal(opts.select, 'username location isAddressHidden');
        assert.equal(opts.transform({ location: 'X', isAddressHidden: true }).location, null);
        assert.equal(opts.transform(null), null);
    });

    test('search only matches locations that are not hidden', () => {
        const rx = /pune/i;
        assert.deepEqual(visibleLocationClauses(rx), [
            { location: rx, isAddressHidden: { $ne: true } },
            { address: rx, isAddressHidden: { $ne: true } },
        ]);
    });
});

describe('#20 business social links', () => {
    test('drops blank rows and normalises platform names', () => {
        assert.deepEqual(
            normalizeSocialLinks([{ platform: ' Instagram ', url: ' https://instagram.com/shop ' }, { platform: 'x', url: '' }, null]),
            [{ platform: 'instagram', url: 'https://instagram.com/shop' }]
        );
        assert.deepEqual(normalizeSocialLinks(null), []);
    });

    test('rejects non-http links, non-lists and too many links', () => {
        assert.throws(() => normalizeSocialLinks([{ platform: 'facebook', url: 'javascript:alert(1)' }]), /must start with http/);
        assert.throws(() => normalizeSocialLinks('https://x.com'), /must be a list/);
        const many = Array.from({ length: SOCIAL_LINK_LIMIT + 1 }, (_, i) => ({ platform: 'web', url: `https://a.com/${i}` }));
        assert.throws(() => normalizeSocialLinks(many), /up to 10/);
    });
});
