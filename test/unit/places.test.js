import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCountryCode, resolveStateName, listCountries, listStates, listCities, filterNames, searchCitiesInCountry,
    placeKind, suggestionFromPhoton, suggestionFromDataset, mergeSuggestions, preferCountry,
    addressFromNominatim, addressFromPhoton, readCoordinates,
} from '../../src/services/places.service.js';
import { matchCities, withMoreTowns } from '../../src/utils/suggestions.utils.js';

// Client list "Improvements" (28 Nov 2026): the location items (5, 9, 18, 24).

// ── 9: Country > State > City ───────────────────────────────────────────────

test('#9 every country is listed, India first, the rest A to Z', () => {
    const countries = listCountries();
    assert.ok(countries.length > 200);
    assert.deepEqual(countries[0], { code: 'IN', name: 'India', dialCode: '+91' });
    const rest = countries.slice(1).map((c) => c.name);
    assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b, 'en')));
    assert.equal(countries.filter((c) => c.code === 'IN').length, 1);
});

test('#9 a country is found by its code or its name, in any case', () => {
    assert.equal(resolveCountryCode('IN'), 'IN');
    assert.equal(resolveCountryCode('in'), 'IN');
    assert.equal(resolveCountryCode('India'), 'IN');
    assert.equal(resolveCountryCode('  india '), 'IN');
    assert.equal(resolveCountryCode('Atlantis'), null);
    assert.equal(resolveCountryCode(''), null);
    assert.equal(resolveCountryCode(undefined), null);
});

test('#9 choosing a country gives only its states', () => {
    const india = listStates('IN');
    assert.equal(india.length, 36);
    assert.ok(india.includes('Tamil Nadu'));
    assert.ok(india.includes('Maharashtra'));
    assert.deepEqual(india, [...india].sort((a, b) => a.localeCompare(b, 'en')));
    // Another country's states are not India's.
    const us = listStates('United States');
    assert.ok(us.includes('California'));
    assert.equal(us.includes('Tamil Nadu'), false);
    assert.deepEqual(listStates('Atlantis'), []);
});

test('#9 choosing Tamil Nadu gives only cities in Tamil Nadu', () => {
    const cities = listCities('IN', 'Tamil Nadu');
    assert.ok(cities.length > 500);
    for (const name of ['Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Erode']) assert.ok(cities.includes(name), name);
    // Cities of other states are not there.
    for (const name of ['Mumbai', 'Pune', 'Bengaluru', 'Kochi']) assert.equal(cities.includes(name), false, name);
    // The state is found whatever case it was sent in.
    assert.equal(resolveStateName('IN', 'tamil nadu'), 'Tamil Nadu');
    assert.deepEqual(listCities('IN', 'TAMIL NADU'), cities);
    assert.deepEqual(listCities('IN', 'Nowhere'), []);
    assert.deepEqual(listCities('Atlantis', 'Tamil Nadu'), []);
});

test('#9 typing narrows the list: names that start with it first', () => {
    const co = listCities('IN', 'Tamil Nadu', { q: 'co' });
    assert.ok(co.length > 0);
    assert.ok(co[0].toLowerCase().startsWith('co'));
    assert.ok(co.includes('Coimbatore'));
    assert.deepEqual(listCities('IN', 'Tamil Nadu', { q: 'zzzzzz' }), []);
    assert.equal(listCities('IN', 'Tamil Nadu', { q: 'a', limit: 5 }).length, 5);

    assert.deepEqual(filterNames(['Salem', 'New Salem', 'Balsalem', 'Erode'], 'sal'), ['Salem', 'New Salem', 'Balsalem']);
    assert.deepEqual(filterNames(['Salem', 'Erode'], ''), ['Salem', 'Erode']);
    assert.deepEqual(filterNames(['Salem', 'Erode'], '  SAL '), ['Salem']);
});

// ── 5: towns and villages, not only the big cities ──────────────────────────

test('#5 Choose city finds smaller towns, each with its state', () => {
    const found = searchCitiesInCountry('abir');
    assert.ok(found.some((c) => c.name === 'Abiramam' && c.state === 'Tamil Nadu'));
    assert.equal(found[0].country, 'India');
    assert.equal(found[0].countryCode, 'IN');
    assert.deepEqual(searchCitiesInCountry(''), []);
    assert.deepEqual(searchCitiesInCountry('abir', { country: 'Atlantis' }), []);
    assert.ok(searchCitiesInCountry('a', { limit: 4 }).length <= 4);
});

test('#5 the big cities and the cities with posts still come first; towns fill the rest', () => {
    const major = matchCities('sal', [], 8);
    assert.equal(major[0].name, 'Salem');
    const all = withMoreTowns(major, searchCitiesInCountry('sal', { limit: 8 }), 8);
    assert.equal(all[0].name, 'Salem');
    assert.ok(all.length > major.length, 'smaller towns were added');
    // Nothing is listed twice, and the list is never longer than asked for.
    assert.equal(new Set(all.map((c) => c.name.toLowerCase())).size, all.length);
    assert.ok(all.length <= 8);
    // A town that was added says which state it is in.
    assert.ok(all.slice(major.length).every((c) => c.hasPosts === false && typeof c.state === 'string'));

    assert.deepEqual(
        withMoreTowns([{ name: 'Pune', hasPosts: true }], [{ name: 'pune', state: 'Maharashtra' }], 8),
        [{ name: 'Pune', hasPosts: true }],
    );
    assert.deepEqual(withMoreTowns([], [], 8), []);
});

test('#5 a search result says what kind of place it is', () => {
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'city' }), 'city');
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'town' }), 'town');
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'village' }), 'village');
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'hamlet' }), 'village');
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'suburb' }), 'area');
    assert.equal(placeKind({ osmKey: 'place', osmValue: 'neighbourhood' }), 'area');
    assert.equal(placeKind({ osmKey: 'highway', osmValue: 'residential', type: 'street' }), 'address');
    assert.equal(placeKind({ type: 'state' }), 'state');
    assert.equal(placeKind({}), 'place');
});

const PHOTON_VILLAGE = {
    geometry: { coordinates: [78.44, 9.44], type: 'Point' },
    properties: {
        name: 'Abiramam', osm_key: 'place', osm_value: 'village', type: 'city', county: 'Ramanathapuram',
        state: 'Tamil Nadu', country: 'India', countrycode: 'IN', postcode: '623601',
    },
};
const PHOTON_AREA = {
    geometry: { coordinates: [73.78, 18.56], type: 'Point' },
    properties: {
        name: 'Baner', osm_key: 'place', osm_value: 'suburb', type: 'district', city: 'Pune',
        state: 'Maharashtra', country: 'India', countrycode: 'IN',
    },
};

test('#5 a village and a local area come out as places a form can use', () => {
    const village = suggestionFromPhoton(PHOTON_VILLAGE);
    assert.equal(village.kind, 'village');
    assert.equal(village.name, 'Abiramam');
    assert.equal(village.label, 'Abiramam, Tamil Nadu, India');
    assert.equal(village.state, 'Tamil Nadu');
    assert.equal(village.postalCode, '623601');
    assert.equal(village.latitude, 9.44);
    assert.equal(village.longitude, 78.44);

    const area = suggestionFromPhoton(PHOTON_AREA);
    assert.equal(area.kind, 'area');
    assert.equal(area.city, 'Pune');
    assert.equal(area.label, 'Baner, Pune, Maharashtra, India');

    assert.equal(suggestionFromPhoton({ properties: {} }), null);
    assert.equal(suggestionFromPhoton(null), null);
});

test('#5 the same place from two sources is listed once', () => {
    const online = [suggestionFromPhoton(PHOTON_VILLAGE)];
    const fromFile = [
        suggestionFromDataset({ name: 'Abiramam', state: 'Tamil Nadu', country: 'India', countryCode: 'IN' }),
        suggestionFromDataset({ name: 'Abirampuram', state: 'Tamil Nadu', country: 'India', countryCode: 'IN' }),
    ];
    const merged = mergeSuggestions([online, fromFile], 10);
    assert.deepEqual(merged.map((s) => s.name), ['Abiramam', 'Abirampuram']);
    // The one that knows where it is on the map is the one that is kept.
    assert.equal(merged[0].latitude, 9.44);
    assert.equal(merged[1].latitude, null);
    assert.equal(mergeSuggestions([online, fromFile], 1).length, 1);
});

test('#5 places in India come before look-alike names from other countries', () => {
    const slovakia = { name: 'Abrahám', state: 'Trnava', country: 'Slovakia', countryCode: 'SK' };
    const india = suggestionFromPhoton(PHOTON_VILLAGE);
    const town = suggestionFromDataset({ name: 'Abirampuram', state: 'Tamil Nadu', country: 'India', countryCode: 'IN' });
    const ordered = mergeSuggestions(preferCountry([slovakia, india], [town], 'IN'), 10);
    assert.deepEqual(ordered.map((p) => p.name), ['Abiramam', 'Abirampuram', 'Abrahám']);
    assert.deepEqual(preferCountry(null, null, 'IN'), [[], [], []]);
});

// ── 18 / 24: Use my current location ────────────────────────────────────────

test('#18 a GPS position is checked before it is looked up', () => {
    assert.deepEqual(readCoordinates('10.79', '78.70'), { latitude: 10.79, longitude: 78.7 });
    assert.equal(readCoordinates('91', '78'), null);
    assert.equal(readCoordinates('10', '181'), null);
    assert.equal(readCoordinates('abc', '78'), null);
    assert.equal(readCoordinates(undefined, undefined), null);
    // 0,0 is a phone with no fix, not a place anyone is.
    assert.equal(readCoordinates('0', '0'), null);
});

test('#24 an address found from GPS is split into the boxes of a form', () => {
    const address = addressFromNominatim({
        lat: '10.7905',
        lon: '78.7047',
        address: {
            house_number: '12', road: 'Gandhi Road', neighbourhood: 'Thillai Nagar', city: 'Tiruchirappalli',
            state_district: 'Tiruchirappalli', state: 'Tamil Nadu', postcode: '620018', country: 'India', country_code: 'in',
        },
    });
    assert.equal(address.addressLine, '12 Gandhi Road, Thillai Nagar');
    assert.equal(address.houseNumber, '12');
    assert.equal(address.locality, 'Thillai Nagar');
    assert.equal(address.city, 'Tiruchirappalli');
    assert.equal(address.state, 'Tamil Nadu');
    assert.equal(address.postalCode, '620018');
    assert.equal(address.country, 'India');
    assert.equal(address.countryCode, 'IN');
    assert.equal(address.label, 'Thillai Nagar, Tiruchirappalli, Tamil Nadu, India');
    assert.equal(address.latitude, 10.7905);
});

test('#24 a village with no street still gives its name, state and PIN code', () => {
    const address = addressFromNominatim({
        lat: '9.44',
        lon: '78.44',
        address: { village: 'Abiramam', county: 'Kamuthi', state: 'Tamil Nadu', postcode: '623601', country: 'India', country_code: 'in' },
    });
    assert.equal(address.city, 'Abiramam');
    assert.equal(address.addressLine, '');
    assert.equal(address.postalCode, '623601');
    assert.equal(address.label, 'Abiramam, Tamil Nadu, India');
    assert.equal(addressFromNominatim({ error: 'Unable to geocode' }), null);
    assert.equal(addressFromNominatim(null), null);
});

test('#24 the fallback service gives the same parts', () => {
    const address = addressFromPhoton({
        geometry: { coordinates: [78.7047, 10.7905] },
        properties: {
            housenumber: '12', street: 'Gandhi Road', district: 'Thillai Nagar', city: 'Tiruchirappalli',
            state: 'Tamil Nadu', postcode: '620018', country: 'India', countrycode: 'IN',
        },
    });
    assert.equal(address.addressLine, '12 Gandhi Road, Thillai Nagar');
    assert.equal(address.city, 'Tiruchirappalli');
    assert.equal(address.postalCode, '620018');
    assert.equal(address.longitude, 78.7047);
    assert.equal(addressFromPhoton(undefined), null);
});
