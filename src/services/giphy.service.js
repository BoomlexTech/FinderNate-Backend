import { redisClient } from '../config/redis.config.js';
import { normalizeGif } from '../utils/giphy.rules.js';

export { normalizeGif };

/**
 * GIF and sticker search (Phase 3 #7).
 *
 * Every request goes through our server so the GIPHY API key stays private,
 * and results are cached in Redis so a popular search costs one GIPHY call.
 *
 * Environment:
 *   GIPHY_API_KEY   required; without it the endpoints answer 503
 *   GIPHY_RATING    optional content rating, default 'pg-13'
 */
const BASE = 'https://api.giphy.com/v1';
const SEARCH_TTL = 60 * 60;        // 1 hour
const TRENDING_TTL = 15 * 60;      // 15 minutes
const ITEM_TTL = 7 * 24 * 60 * 60; // a GIF's details, 7 days
const TIMEOUT_MS = 6000;

export const giphyConfigured = () => !!process.env.GIPHY_API_KEY;

const rating = () => process.env.GIPHY_RATING || 'pg-13';

const cacheGet = async (key) => {
    try {
        const hit = await redisClient.get(key);
        return hit ? JSON.parse(hit) : null;
    } catch {
        return null;
    }
};

const cacheSet = async (key, value, ttl) => {
    try {
        await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
    } catch { /* cache is best effort */ }
};

const call = async (path, params) => {
    const url = new URL(`${BASE}${path}`);
    Object.entries({ ...params, api_key: process.env.GIPHY_API_KEY }).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GIPHY answered ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
};

const clampLimit = (n) => Math.min(Math.max(parseInt(n, 10) || 24, 1), 50);
const clampOffset = (n) => Math.min(Math.max(parseInt(n, 10) || 0, 0), 4999);

/** Search or trending. `type` is 'gifs' or 'stickers'. */
export const listGifs = async ({ q = '', type = 'gifs', limit, offset } = {}) => {
    const kind = type === 'stickers' ? 'stickers' : 'gifs';
    const query = String(q || '').trim().slice(0, 50).toLowerCase();
    const lim = clampLimit(limit);
    const off = clampOffset(offset);
    const key = `giphy:${kind}:${query ? `s:${query}` : 'trending'}:${lim}:${off}:${rating()}`;

    const cached = await cacheGet(key);
    if (cached) return cached;

    const json = query
        ? await call(`/${kind}/search`, { q: query, limit: lim, offset: off, rating: rating(), lang: 'en' })
        : await call(`/${kind}/trending`, { limit: lim, offset: off, rating: rating() });

    const items = (json?.data || []).map((g) => normalizeGif(g, kind)).filter(Boolean);
    const total = Number(json?.pagination?.total_count) || items.length;
    const result = { items, nextOffset: off + lim < total ? off + lim : null };

    await cacheSet(key, result, query ? SEARCH_TTL : TRENDING_TTL);
    // Remember each item, so sending one doesn't need another GIPHY call.
    await Promise.all(items.map((it) => cacheSet(`giphy:item:${it.id}`, it, ITEM_TTL)));
    return result;
};

/** One GIF or sticker by id, for building a message. Returns null if gone. */
export const lookupGif = async (id) => {
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
    const cached = await cacheGet(`giphy:item:${id}`);
    if (cached) return cached;
    if (!giphyConfigured()) return null;
    const json = await call(`/gifs/${encodeURIComponent(id)}`, {});
    const item = normalizeGif(json?.data);
    if (item) await cacheSet(`giphy:item:${id}`, item, ITEM_TTL);
    return item;
};
