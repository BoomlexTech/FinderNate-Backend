import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
    listCountries,
    listStates,
    listCities,
    resolveCountryCode,
    resolveStateName,
    searchPlaces,
    reverseGeocode,
    readCoordinates,
} from '../services/places.service.js';

/**
 * Places for the forms (client list, 28 Nov 2026: items 5, 9, 18 and 24).
 *
 *   GET /meta/places/countries
 *   GET /meta/places/states?country=IN
 *   GET /meta/places/cities?country=IN&state=Tamil Nadu&q=tri
 *   GET /meta/places/search?q=abir          towns, villages and local areas
 *   GET /meta/places/reverse?lat=..&lon=..  "Use my current location"
 *
 * All public: a sign-up form and a guest checkout need them before anyone is
 * signed in. The lists never change between releases, so they may be cached
 * by the caller for a day.
 */

const cacheForADay = (res) => res.set('Cache-Control', 'public, max-age=86400');

export const getCountries = asyncHandler(async (req, res) => {
    cacheForADay(res);
    return res.status(200).json(new ApiResponse(200, { countries: listCountries() }, 'Countries'));
});

export const getStates = asyncHandler(async (req, res) => {
    const code = resolveCountryCode(req.query.country || 'IN');
    if (!code) throw new ApiError(404, 'We do not have that country in our list');
    cacheForADay(res);
    return res.status(200).json(new ApiResponse(200, { country: code, states: listStates(code) }, 'States'));
});

export const getCities = asyncHandler(async (req, res) => {
    const code = resolveCountryCode(req.query.country || 'IN');
    if (!code) throw new ApiError(404, 'We do not have that country in our list');
    const state = resolveStateName(code, req.query.state);
    if (!state) throw new ApiError(404, 'We do not have that state in our list');

    const q = String(req.query.q ?? '').slice(0, 60);
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 2000));
    if (!q) cacheForADay(res);
    return res.status(200).json(new ApiResponse(200, {
        country: code,
        state,
        cities: listCities(code, state, { q, limit }),
    }, 'Cities'));
});

export const searchAllPlaces = asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 80);
    const limit = Math.min(15, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const country = resolveCountryCode(req.query.country) || 'IN';
    const places = await searchPlaces(q, { limit, country });
    return res.status(200).json(new ApiResponse(200, { places }, 'Places'));
});

export const reversePlace = asyncHandler(async (req, res) => {
    const position = readCoordinates(req.query.lat, req.query.lon ?? req.query.lng);
    if (!position) throw new ApiError(400, 'That position is not valid');

    const place = await reverseGeocode(position.latitude, position.longitude);
    if (!place) {
        // 200 with nothing found, not an error: the form says "we could not
        // work out the address" and the person types it.
        return res.status(200).json(new ApiResponse(200, { place: null, ...position }, 'No address found for that position'));
    }
    return res.status(200).json(new ApiResponse(200, { place }, 'Address found'));
});
