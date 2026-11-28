import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Places: the lists behind the Country > State > City dropdowns, the place
 * search that reaches towns, villages and local areas, and turning a GPS fix
 * into an address ("Use my current location").
 *
 * Two sources:
 *
 *  - src/data/places.json.gz: every country with its states and the cities
 *    and towns in each (250 countries, about 4,000 states and 52,000 places;
 *    names only). Built once from the MIT-licensed `countrycitystatejson`
 *    data, read here as a data file: no package is loaded at run time.
 *    India: 36 states and union territories, about 5,700 cities and towns.
 *
 *  - OpenStreetMap, through Photon (search as you type) and Nominatim
 *    (coordinates to address). These know villages, hamlets and
 *    neighbourhoods that no fixed list does. They are free services with fair
 *    use rules, so every answer is kept in memory for a while and the routes
 *    are rate limited per caller.
 *
 * Everything that parses an answer is a pure function and is exported, so it
 * is unit tested without the network.
 */

// ── The data file ────────────────────────────────────────────────────────────

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/places.json.gz');

let countriesByCode = null;

const loadCountries = () => {
    if (!countriesByCode) {
        const json = zlib.gunzipSync(fs.readFileSync(DATA_FILE)).toString('utf8');
        countriesByCode = JSON.parse(json).countries || {};
    }
    return countriesByCode;
};

const fold = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** "IN", "in" or "India" -> "IN". Null when there is no such country. */
export const resolveCountryCode = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const countries = loadCountries();
    const upper = text.toUpperCase();
    if (countries[upper]) return upper;
    const wanted = fold(text);
    return Object.keys(countries).find((code) => fold(countries[code].name) === wanted) || null;
};

/** The exact name of a state as the list spells it, whatever case was sent. */
export const resolveStateName = (countryCode, value) => {
    const states = loadCountries()[countryCode]?.states;
    if (!states) return null;
    const text = String(value ?? '').trim();
    if (states[text]) return text;
    const wanted = fold(text);
    return Object.keys(states).find((name) => fold(name) === wanted) || null;
};

/** Every country, A to Z, with `first` (India by default) moved to the top. */
export const listCountries = ({ first = 'IN' } = {}) => {
    const countries = loadCountries();
    const list = Object.keys(countries)
        .map((code) => ({ code, name: countries[code].name, dialCode: countries[code].phone ? `+${countries[code].phone}` : '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const pinned = list.findIndex((country) => country.code === first);
    if (pinned > 0) list.unshift(...list.splice(pinned, 1));
    return list;
};

/** The states of a country, A to Z. Empty for an unknown country. */
export const listStates = (country) => {
    const code = resolveCountryCode(country);
    const states = code ? loadCountries()[code].states : null;
    return states ? Object.keys(states).sort((a, b) => a.localeCompare(b, 'en')) : [];
};

/**
 * Names matching what has been typed, best first: names that start with it,
 * then names with a word that does, then names that contain it. No query
 * means the list as it is (A to Z).
 */
export const filterNames = (names, query, limit) => {
    const q = fold(query);
    const max = Math.max(1, limit || names.length);
    if (!q) return names.slice(0, max);
    const tier = (name) => {
        const key = fold(name);
        if (key.startsWith(q)) return 0;
        if (key.split(/[\s-]/).some((word) => word.startsWith(q))) return 1;
        return key.includes(q) ? 2 : 9;
    };
    return names
        .map((name) => ({ name, t: tier(name) }))
        .filter((entry) => entry.t < 9)
        .sort((a, b) => a.t - b.t || a.name.localeCompare(b.name, 'en'))
        .slice(0, max)
        .map((entry) => entry.name);
};

/** The cities and towns of one state, optionally narrowed by what was typed. */
export const listCities = (country, state, { q = '', limit = 1000 } = {}) => {
    const code = resolveCountryCode(country);
    const stateName = code ? resolveStateName(code, state) : null;
    if (!stateName) return [];
    return filterNames(loadCountries()[code].states[stateName], q, limit);
};

/**
 * Cities and towns across a whole country that match what was typed, each
 * with its state. Used to widen "Choose city" beyond the big cities.
 */
export const searchCitiesInCountry = (query, { country = 'IN', limit = 10 } = {}) => {
    const q = fold(query);
    const code = resolveCountryCode(country);
    if (!q || !code) return [];
    const { name: countryName, states } = loadCountries()[code];

    const starts = [];
    const contains = [];
    for (const state of Object.keys(states)) {
        for (const city of states[state]) {
            const key = fold(city);
            if (key.startsWith(q)) starts.push({ name: city, state });
            else if (q.length >= 3 && key.includes(q)) contains.push({ name: city, state });
        }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'en') || a.state.localeCompare(b.state, 'en');
    return [...starts.sort(byName), ...contains.sort(byName)]
        .slice(0, Math.max(1, limit))
        .map((entry) => ({ ...entry, country: countryName, countryCode: code }));
};

// ── OpenStreetMap answers, made into one shape ───────────────────────────────

const text = (value) => String(value ?? '').trim();

const uniqueParts = (parts) => {
    const seen = new Set();
    return parts.map(text).filter((part) => {
        const key = part.toLowerCase();
        if (!part || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/** What sort of place an OpenStreetMap result is, in the words the apps show. */
export const placeKind = ({ osmKey, osmValue, type } = {}) => {
    const value = text(osmValue).toLowerCase();
    if (text(osmKey).toLowerCase() === 'place') {
        if (value === 'city') return 'city';
        if (value === 'town') return 'town';
        if (value === 'village' || value === 'hamlet' || value === 'isolated_dwelling') return 'village';
        if (['suburb', 'neighbourhood', 'quarter', 'locality', 'borough', 'city_block'].includes(value)) return 'area';
        if (value === 'state' || value === 'province') return 'state';
        if (value === 'country') return 'country';
        if (value === 'county' || value === 'district' || value === 'municipality') return 'district';
    }
    switch (text(type).toLowerCase()) {
        case 'city': return 'city';
        case 'district': case 'locality': return 'area';
        case 'county': return 'district';
        case 'state': return 'state';
        case 'country': return 'country';
        case 'street': case 'house': return 'address';
        default: return 'place';
    }
};

/** One Photon feature as a suggestion. Null when it has no usable name. */
export const suggestionFromPhoton = (feature) => {
    const p = feature?.properties || {};
    const name = text(p.name);
    if (!name) return null;
    const coordinates = feature?.geometry?.coordinates;
    const kind = placeKind({ osmKey: p.osm_key, osmValue: p.osm_value, type: p.type });
    // The city a smaller place belongs to; for a city it is the place itself.
    const city = kind === 'city' || kind === 'town' ? name : text(p.city || p.county);
    return {
        label: uniqueParts([name, kind === 'city' || kind === 'town' ? '' : p.city, p.state, p.country]).join(', '),
        name,
        kind,
        city,
        district: text(p.county),
        state: text(p.state),
        country: text(p.country),
        countryCode: text(p.countrycode).toUpperCase(),
        postalCode: text(p.postcode),
        latitude: Array.isArray(coordinates) && Number.isFinite(coordinates[1]) ? coordinates[1] : null,
        longitude: Array.isArray(coordinates) && Number.isFinite(coordinates[0]) ? coordinates[0] : null,
    };
};

/** A town from the data file as a suggestion (it has no coordinates). */
export const suggestionFromDataset = ({ name, state, country, countryCode }) => ({
    label: uniqueParts([name, state, country]).join(', '),
    name,
    kind: 'town',
    city: name,
    district: '',
    state: state || '',
    country: country || '',
    countryCode: countryCode || '',
    postalCode: '',
    latitude: null,
    longitude: null,
});

/**
 * Suggestions from several sources in one list, in the order given, with the
 * same place listed once (the same name in the same state is the same place).
 */
export const mergeSuggestions = (lists, limit = 10) => {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        for (const suggestion of list || []) {
            if (!suggestion) continue;
            const key = `${fold(suggestion.name)}|${fold(suggestion.state)}|${fold(suggestion.countryCode || suggestion.country)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(suggestion);
            if (merged.length >= limit) return merged;
        }
    }
    return merged;
};

/**
 * A Nominatim reverse answer as the parts a form needs. `addressLine` is the
 * street part (number, road, neighbourhood); the rest go in their own boxes.
 */
export const addressFromNominatim = (json) => {
    const a = json?.address;
    if (!a) return null;
    const locality = text(a.neighbourhood || a.suburb || a.quarter || a.hamlet || a.residential || a.city_district);
    const city = text(a.city || a.town || a.village || a.municipality || a.county || a.state_district);
    const road = text(a.road || a.pedestrian || a.footway);
    const addressLine = uniqueParts([a.house_number && road ? `${a.house_number} ${road}` : road, locality]).join(', ');
    const state = text(a.state || a.region);
    const country = text(a.country);
    return {
        label: uniqueParts([locality || road, city, state, country]).join(', '),
        addressLine,
        houseNumber: text(a.house_number),
        road,
        locality,
        city,
        district: text(a.state_district || a.county),
        state,
        country,
        countryCode: text(a.country_code).toUpperCase(),
        postalCode: text(a.postcode),
        latitude: Number.isFinite(Number(json.lat)) ? Number(json.lat) : null,
        longitude: Number.isFinite(Number(json.lon)) ? Number(json.lon) : null,
    };
};

/** The same parts from a Photon reverse answer (the fallback). */
export const addressFromPhoton = (feature) => {
    const p = feature?.properties;
    if (!p) return null;
    const coordinates = feature?.geometry?.coordinates;
    const road = text(p.street || (p.type === 'street' ? p.name : ''));
    const locality = text(p.locality || p.district);
    const city = text(p.city || p.county);
    const state = text(p.state);
    const country = text(p.country);
    return {
        label: uniqueParts([locality || road || p.name, city, state, country]).join(', '),
        addressLine: uniqueParts([p.housenumber && road ? `${p.housenumber} ${road}` : road, locality]).join(', '),
        houseNumber: text(p.housenumber),
        road,
        locality,
        city,
        district: text(p.county),
        state,
        country,
        countryCode: text(p.countrycode).toUpperCase(),
        postalCode: text(p.postcode),
        latitude: Array.isArray(coordinates) && Number.isFinite(coordinates[1]) ? coordinates[1] : null,
        longitude: Array.isArray(coordinates) && Number.isFinite(coordinates[0]) ? coordinates[0] : null,
    };
};

/** A latitude and longitude that are really on the map, or null. */
export const readCoordinates = (lat, lon) => {
    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    // 0,0 is what a phone reports when it has no fix at all.
    if (latitude === 0 && longitude === 0) return null;
    return { latitude, longitude };
};

// ── Asking OpenStreetMap ────────────────────────────────────────────────────

// Required by the usage policy of both services: say who is asking.
const OSM_HEADERS = { 'User-Agent': 'Findernate/1.0 (https://findernate.com)', Accept: 'application/json', 'Accept-Language': 'en' };
const TIMEOUT_MS = 6000;

/** A small "keep the newest N" memory, with a time limit per entry. */
const makeCache = (max, ttlMs) => {
    const store = new Map();
    return {
        get(key) {
            const hit = store.get(key);
            if (!hit) return undefined;
            if (Date.now() - hit.at > ttlMs) {
                store.delete(key);
                return undefined;
            }
            return hit.value;
        },
        set(key, value) {
            if (store.size >= max) store.delete(store.keys().next().value);
            store.set(key, { value, at: Date.now() });
        },
    };
};

const searchCache = makeCache(800, 30 * 60 * 1000);
const reverseCache = makeCache(800, 24 * 60 * 60 * 1000);

const getJson = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, { headers: OSM_HEADERS, signal: controller.signal });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

const photonSearch = async (q, { placesOnly }) => {
    const params = new URLSearchParams({
        q,
        limit: '10',
        lang: 'en',
        // Leans towards India, where nearly everyone using Findernate is,
        // without shutting the rest of the world out.
        lat: '22.35',
        lon: '78.67',
        zoom: '5',
        location_bias_scale: '0.2',
    });
    // Cities, towns, villages, hamlets, suburbs and neighbourhoods only: no
    // shops, bus stops or roads that merely share the name.
    if (placesOnly) params.append('osm_tag', 'place');
    const json = await getJson(`https://photon.komoot.io/api/?${params.toString()}`);
    return Array.isArray(json?.features) ? json.features.map(suggestionFromPhoton).filter(Boolean) : [];
};

/**
 * The order suggestions are shown in: places in the person's own country
 * first (map results, then towns from the data file), and only then
 * look-alike names from the rest of the world. The search is fuzzy, so
 * "abiramam" also brings back towns in Slovakia and Syria; they must not
 * sit above an Indian town of the right name. Pure.
 */
export const preferCountry = (online, fromFile, countryCode) => {
    const home = (online || []).filter((place) => place.countryCode === countryCode);
    const abroad = (online || []).filter((place) => place.countryCode !== countryCode);
    return [home, fromFile || [], abroad];
};

/**
 * Places at every level matching what was typed: cities, towns, villages and
 * local areas. Never throws; with OpenStreetMap unreachable it still answers
 * from the data file.
 */
export const searchPlaces = async (query, { limit = 10, country = 'IN' } = {}) => {
    const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return [];
    const max = Math.min(15, Math.max(1, limit));
    const cacheKey = `${fold(q)}|${max}|${country}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return cached;

    let online = await photonSearch(q, { placesOnly: true });
    if (online.length === 0) online = await photonSearch(q, { placesOnly: false });

    const fromFile = searchCitiesInCountry(q, { country, limit: max }).map(suggestionFromDataset);
    const merged = mergeSuggestions(preferCountry(online, fromFile, country), max);
    // Only a real answer is remembered: an empty one may just be a timeout.
    if (online.length > 0) searchCache.set(cacheKey, merged);
    return merged;
};

/**
 * The address at a GPS position, or null when neither service could say.
 * Positions are rounded to about 11 metres for the memory, which is finer
 * than a phone's fix indoors.
 */
export const reverseGeocode = async (latitude, longitude) => {
    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = reverseCache.get(cacheKey);
    if (cached) return cached;

    const nominatim = await getJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${latitude}&lon=${longitude}`
    );
    let address = addressFromNominatim(nominatim);

    if (!address) {
        const photon = await getJson(`https://photon.komoot.io/reverse?lang=en&lat=${latitude}&lon=${longitude}`);
        address = addressFromPhoton(photon?.features?.[0]);
    }
    if (!address) return null;

    // The position asked about, when the service did not echo one.
    const result = { ...address, latitude: address.latitude ?? latitude, longitude: address.longitude ?? longitude };
    reverseCache.set(cacheKey, result);
    return result;
};
