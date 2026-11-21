import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FEED_SEED_WINDOW_MS, feedSeed, hashString, seededShuffler } from '../../src/utils/feedOrder.utils.js';

// Found 21 Nov 2026 in the app's Explore grid: the same posts twice. The
// explore controller reshuffled its candidates with Math.random on every
// request and then cut out page N, so pages overlapped.

const posts = (n) => Array.from({ length: n }, (_, i) => ({ _id: `p${i}` }));
const ids = (list) => list.map((p) => p._id);

// The controller's page cut: shuffle the candidates, then slice page N.
const page = (candidates, seed, n, size) =>
    seededShuffler(seed)(candidates).slice((n - 1) * size, n * size);

test('every page of one session comes from the same order', () => {
    const candidates = posts(60);
    const seed = feedSeed({ viewerId: 'u1', clientSeed: 'abc' });
    const shown = [1, 2, 3].flatMap((n) => ids(page(candidates, seed, n, 20)));
    assert.equal(shown.length, 60);
    assert.equal(new Set(shown).size, 60, 'no post twice, none left out');
});

test('a post published between two page requests does not reshuffle the rest', () => {
    const seed = feedSeed({ viewerId: 'u1', clientSeed: 'abc' });
    const before = ids(seededShuffler(seed)(posts(60)));
    const after = ids(seededShuffler(seed)([{ _id: 'new' }, ...posts(60)]));
    assert.deepEqual(after.filter((id) => id !== 'new'), before);
});

test('a new seed (pull to refresh) gives a new order, the same seed the same one', () => {
    const candidates = posts(40);
    const a = ids(seededShuffler(feedSeed({ viewerId: 'u1', clientSeed: 'one' }))(candidates));
    const b = ids(seededShuffler(feedSeed({ viewerId: 'u1', clientSeed: 'two' }))(candidates));
    const a2 = ids(seededShuffler(feedSeed({ viewerId: 'u1', clientSeed: 'one' }))(candidates));
    assert.notDeepEqual(a, b);
    assert.deepEqual(a, a2);
});

test('without a client seed the order holds for the 30-minute window', () => {
    const start = 1_800_000_000_000 - (1_800_000_000_000 % FEED_SEED_WINDOW_MS);
    assert.equal(
        feedSeed({ viewerId: 'u1', now: start + 1_000 }),
        feedSeed({ viewerId: 'u1', now: start + FEED_SEED_WINDOW_MS - 1_000 })
    );
    assert.notEqual(
        feedSeed({ viewerId: 'u1', now: start + 1_000 }),
        feedSeed({ viewerId: 'u2', now: start + 1_000 }),
        'two viewers get different orders'
    );
    assert.equal(feedSeed({ viewerId: null, clientSeed: '  ' , now: start }), `guest:w${start / FEED_SEED_WINDOW_MS}`);
});

test('hashString is a stable 32-bit hash', () => {
    assert.equal(hashString(''), 0x811c9dc5);
    assert.equal(hashString('a'), 0xe40c292c);
    assert.ok(Number.isInteger(hashString('findernate')) && hashString('findernate') >= 0);
});

test('the explore controller orders with the seeded shuffler, not Math.random', async () => {
    const src = await readFile(new URL('../../src/controllers/explore.controllers.js', import.meta.url), 'utf8');
    assert.match(src, /const shuffleArray = seededShuffler\(feedSeed\(\{ viewerId, clientSeed: seed \}\)\);/);
    assert.match(src, /sortBy = "time", page = 1, limit = 10, seed \} = req\.query/);
    assert.doesNotMatch(src, /sort: Math\.random\(\)/);
});
