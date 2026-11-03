/**
 * Pure helpers for the Phase 2 fields a post can be created with:
 * subcategories (#17), media framing (#3) and collaborator invites (#50).
 * Kept free of models so they can be unit-tested.
 */

export const MAX_SUBCATEGORIES = 10;
export const MAX_SUBCATEGORY_LENGTH = 40;
export const MAX_COLLABORATORS = 3;

const parseMaybeJson = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try { return JSON.parse(trimmed); } catch { return undefined; }
    }
    return trimmed;
};

/**
 * Up to 10 subcategories: trimmed, inner whitespace collapsed, empty and
 * over-long entries dropped, de-duplicated case-insensitively (first spelling
 * wins). Accepts an array, a JSON array string or a comma-separated string.
 * Returns undefined when nothing was sent, so the field stays unset.
 */
export const normalizeSubcategories = (value) => {
    const parsed = parseMaybeJson(value);
    if (parsed === undefined || parsed === null) return undefined;
    const list = Array.isArray(parsed) ? parsed : String(parsed).split(',');
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        const text = String(raw).replace(/\s+/g, ' ').trim();
        if (!text || text.length > MAX_SUBCATEGORY_LENGTH) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= MAX_SUBCATEGORIES) break;
    }
    return out;
};

/**
 * Display formats (#3). Boundaries are the midpoints between neighbours:
 * r = width / height.
 */
export const ASPECTS = Object.freeze({
    portrait: { key: '4:5', width: 1080, height: 1350 },
    square: { key: '1:1', width: 1080, height: 1080 },
    landscape: { key: '1.91:1', width: 1080, height: 566 },
    vertical: { key: '9:16', width: 1080, height: 1920 },
});
export const SUPPORTED_ASPECT_KEYS = ['4:5', '1:1', '1.91:1', '9:16'];

/** Nearest feed format for a width/height. Vibes always use 9:16. */
export const classifyAspect = (width, height, { isVibe = false } = {}) => {
    if (isVibe) return '9:16';
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return null;
    const r = w / h;
    if (r < 0.894) return '4:5';
    if (r <= 1.382) return '1:1';
    return '1.91:1';
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * The crop window for a video, as fractions of the source frame. Rejects
 * anything that isn't a real rectangle inside the frame.
 */
export const normalizeCrop = (crop) => {
    if (!crop || typeof crop !== 'object') return undefined;
    const x = Number(crop.x), y = Number(crop.y), width = Number(crop.width), height = Number(crop.height);
    if (![x, y, width, height].every(Number.isFinite)) return undefined;
    if (width <= 0 || height <= 0) return undefined;
    const cx = clamp01(x), cy = clamp01(y);
    const cw = Math.min(width, 1 - cx), ch = Math.min(height, 1 - cy);
    if (cw < 0.05 || ch < 0.05) return undefined;
    const round = (n) => Math.round(n * 10000) / 10000;
    return { x: round(cx), y: round(cy), width: round(cw), height: round(ch) };
};

/**
 * Attach aspect (and, for videos, crop) to freshly uploaded media.
 *
 * `layout` is what the composer sent: either { aspect, items: [{ crop }] } or
 * an array of { aspect, crop } per media item. A carousel uses the first
 * item's format for every item, as the plan says. When the client sent
 * nothing (older apps) the aspect is inferred from the first item's size.
 */
export const applyMediaLayout = (media, layout, { isVibe = false } = {}) => {
    if (!Array.isArray(media) || media.length === 0) return media;
    const parsed = parseMaybeJson(layout);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    const requested = (Array.isArray(parsed) ? parsed[0]?.aspect : parsed?.aspect) || null;

    const first = media[0];
    const aspect = isVibe
        ? '9:16'
        : SUPPORTED_ASPECT_KEYS.includes(requested) && requested !== '9:16'
            ? requested
            : classifyAspect(first?.dimensions?.width, first?.dimensions?.height);

    return media.map((m, i) => {
        const out = { ...m };
        if (aspect) out.aspect = aspect;
        if (m?.type === 'video') {
            const crop = normalizeCrop(items[i]?.crop);
            if (crop) out.crop = crop;
        }
        return out;
    });
};

/** Distinct, valid-looking ids from whatever the composer sent, minus the owner. */
export const normalizeCollaboratorIds = (value, ownerId, isValidId) => {
    const parsed = parseMaybeJson(value);
    if (parsed === undefined || parsed === null) return [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const id = String(typeof raw === 'object' && raw ? (raw._id || raw.userId || '') : raw).trim();
        if (!id || !isValidId(id) || id === String(ownerId) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_COLLABORATORS) break;
    }
    return out;
};
