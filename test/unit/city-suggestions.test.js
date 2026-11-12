import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCities, COMMON_CITIES } from '../../src/utils/suggestions.utils.js';

// "Choose city" suggests cities as soon as the user starts typing.
test('suggests after a single letter, names that start with it first', () => {
    const r = matchCities('p');
    assert.ok(r.length > 0);
    assert.ok(r[0].name.toLowerCase().startsWith('p'));
    assert.ok(r.some((c) => c.name === 'Pune'));
});

test('narrows as more is typed, ignoring case and extra spaces', () => {
    assert.deepEqual(matchCities('  PUN ').map((c) => c.name), ['Pune']);
    assert.ok(matchCities('ben')[0].name === 'Bengaluru');
});

test('cities that have posts come first, even from outside the built-in list', () => {
    const r = matchCities('ko', ['kozhikode', 'kodaikanal']);
    assert.equal(r[0].hasPosts, true);
    assert.ok(r.some((c) => c.name === 'Kodaikanal' && c.hasPosts));
    assert.ok(r.some((c) => c.name === 'Kolkata' && !c.hasPosts));
});

test('a word inside a name matches ("mumbai" finds Navi Mumbai) after names that start with it', () => {
    const r = matchCities('mumbai').map((c) => c.name);
    assert.deepEqual(r.slice(0, 2), ['Mumbai', 'Navi Mumbai']);
});

test('no duplicates, respects the limit, empty text gives nothing', () => {
    const r = matchCities('a', ['agra', 'Agra'], 5);
    assert.equal(r.length, 5);
    assert.equal(new Set(r.map((c) => c.name)).size, 5);
    assert.deepEqual(matchCities(''), []);
    assert.deepEqual(matchCities('zzzz'), []);
});

test('the built-in list has no duplicate names', () => {
    const keys = COMMON_CITIES.map((c) => c.toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
});
