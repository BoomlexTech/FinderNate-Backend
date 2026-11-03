import Setting from '../models/settings.models.js';

/**
 * Read an admin setting with a fallback, cached in memory for a minute so hot
 * paths (view tracking, feeds) don't query it on every request.
 */
const TTL_MS = 60 * 1000;
const memo = new Map();

export const getSettingValue = async (key, fallback) => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value ?? fallback;
    try {
        const row = await Setting.findOne({ key }).select('value').lean();
        memo.set(key, { value: row?.value, at: Date.now() });
        return row?.value ?? fallback;
    } catch {
        return fallback;
    }
};

export const clearSettingCache = (key) => (key ? memo.delete(key) : memo.clear());
