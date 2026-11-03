/**
 * Pure helpers for composer suggestions (Phase 2 #11, #45).
 */

/** A hashtag query: no '#', lower-case, word characters only. */
export const cleanTagQuery = (q) => String(q ?? '').replace(/^#+/, '').trim().toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 50);

/** Escape for a RegExp. */
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Hashtags already in a caption (lower-case, no '#'). */
export const tagsInText = (text) => {
    const out = new Set();
    const re = /#([\p{L}\p{N}_]+)/gu;
    let m;
    while ((m = re.exec(String(text ?? '')))) out.add(m[1].toLowerCase());
    return [...out];
};

/**
 * Words in a caption that could be a hashtag (3+ letters, not a number, not
 * a common stop word). Lower-case, de-duplicated, at most 30.
 */
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'are', 'was', 'have', 'has', 'our', 'out', 'new', 'all', 'now', 'get', 'its', 'not', 'but', 'can', 'just', 'more', 'will', 'who', 'what', 'how', 'when', 'here', 'there', 'they', 'them', 'very', 'also', 'into', 'about']);
export const candidateWords = (text) => {
    const words = String(text ?? '').toLowerCase().replace(/#[\p{L}\p{N}_]+/gu, ' ').match(/[\p{L}][\p{L}\p{N}_]{2,29}/gu) || [];
    return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 30);
};

/**
 * Merge suggestion sources into one ranked list without the tags already
 * used. Earlier sources weigh more; a tag found by several sources rises.
 */
export const mergeTagSuggestions = (sources, exclude = [], limit = 15) => {
    const skip = new Set(exclude.map((t) => String(t).toLowerCase()));
    const score = new Map();
    const reason = new Map();
    sources.forEach(({ name, tags }, i) => {
        const weight = sources.length - i;
        (tags || []).forEach((tag, rank) => {
            const t = String(tag).toLowerCase();
            if (!t || skip.has(t)) return;
            score.set(t, (score.get(t) || 0) + weight * 10 - rank * 0.1);
            if (!reason.has(t)) reason.set(t, name);
        });
    });
    return [...score.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag]) => ({ tag, reason: reason.get(tag) }));
};

/**
 * City key for trending (#42): the part before the first comma, lower-case,
 * single-spaced. "Pune, Maharashtra" and " pune " are the same city.
 */
export const cityKey = (value) => {
    const first = String(value ?? '').split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();
    return first.length >= 2 && first.length <= 60 ? first : '';
};

/** Discount fraction for a product, or 0 when it isn't a deal. */
export const discountOf = (product) => {
    const price = Number(product?.price);
    const original = Number(product?.originalPrice);
    if (!(price >= 0) || !(original > 0) || original <= price) return 0;
    return Math.round(((original - price) / original) * 100) / 100;
};

/**
 * Trending score: engagement decayed by age, so a busy post from today beats
 * a slightly busier one from last week.
 */
export const trendingScore = ({ likes = 0, comments = 0, shares = 0, saves = 0, views = 0 }, ageHours) =>
    (likes + 2 * comments + 3 * shares + saves + views / 20 + 1) / Math.pow(Math.max(0, ageHours) + 2, 1.2);
