import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Found 25 Nov 2026: GET /users/search/instant?q=headphones answered 500 for
// everyone, signed in or not, while ?q=niranjan (people only) answered 200.
// filterVisibleListings read `req.user?._id`, and there is no `req` in that
// helper, so it threw "req is not defined" whenever a search found a product.

const src = await readFile(new URL('../../src/controllers/search.controllers.js', import.meta.url), 'utf8');

// The helper itself, cut out of the controller and run with a stand-in for
// the plan filter. Nothing else is in scope, exactly as in the controller, so
// a name it should not be using throws here the way it did on the server.
const start = src.indexOf('const filterVisibleListings = async');
const end = src.indexOf('\n};', start) + 3;
assert.ok(start > 0 && end > start, 'filterVisibleListings is still in search.controllers.js');
const makeHelper = new Function(
    'filterBusinessPostsByPaymentPlan',
    `${src.slice(start, end)}\nreturn filterVisibleListings;`
);

const rows = [
    { _id: 'p1', userId: 'paidSeller', contentType: 'product' },
    { _id: 'p2', userId: 'freeSeller', contentType: 'product' },
];
// Stand-in for the real rule: a seller without a plan is hidden from others.
const planFilter = (calls) => async (posts, viewerId) => {
    calls.push({ ids: posts.map((p) => p._id), viewerId });
    return posts.filter((p) => p.userId !== 'freeSeller');
};

test('a signed-out search that finds products does not throw', async () => {
    const calls = [];
    const filterVisibleListings = makeHelper(planFilter(calls));
    const visible = await filterVisibleListings(rows, undefined);
    assert.deepEqual(visible.map((r) => r._id), ['p1']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].viewerId, undefined);
});

test('the viewer is passed on, and a seller still finds their own listing', async () => {
    const calls = [];
    const filterVisibleListings = makeHelper(planFilter(calls));
    const visible = await filterVisibleListings(rows, 'freeSeller');
    // Their own listing is kept without asking the plan filter about it.
    assert.deepEqual(visible.map((r) => r._id), ['p1', 'p2']);
    assert.deepEqual(calls[0], { ids: ['p1'], viewerId: 'freeSeller' });
});

test('no results: nothing to filter, nothing asked', async () => {
    const calls = [];
    const filterVisibleListings = makeHelper(planFilter(calls));
    assert.deepEqual(await filterVisibleListings([], 'someone'), []);
    assert.equal(calls.length, 0);
});

test('both instant-search paths hand the viewer to the helper', () => {
    assert.match(src, /filterVisibleListings\(rows, viewerId\)/);
    assert.match(src, /filterVisibleListings\(products, viewerId\)/);
    assert.match(src, /dropUnpaidSellerHits\(liveProducts, req\.user\?\._id\)/);
    assert.match(src, /mongoInstantFallback\(query, blockedUsers, limit, req\.user\?\._id\)/);
});
