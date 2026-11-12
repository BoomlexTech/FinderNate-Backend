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

/**
 * Cities offered while someone types in "Choose city". Major Indian cities, so
 * the box is useful before any post carries a location; cities that do have
 * posts (see matchCities' `withPosts`) are listed ahead of these.
 */
export const COMMON_CITIES = [
    'Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Kolkata', 'Pune', 'Jaipur', 'Surat',
    'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Thane', 'Bhopal', 'Visakhapatnam', 'Patna', 'Vadodara', 'Ghaziabad',
    'Ludhiana', 'Agra', 'Nashik', 'Faridabad', 'Meerut', 'Rajkot', 'Varanasi', 'Srinagar', 'Aurangabad', 'Dhanbad',
    'Amritsar', 'Navi Mumbai', 'Allahabad', 'Ranchi', 'Howrah', 'Coimbatore', 'Jabalpur', 'Gwalior', 'Vijayawada', 'Jodhpur',
    'Madurai', 'Raipur', 'Kota', 'Guwahati', 'Chandigarh', 'Solapur', 'Hubli', 'Mysuru', 'Tiruchirappalli', 'Bareilly',
    'Aligarh', 'Tiruppur', 'Moradabad', 'Jalandhar', 'Bhubaneswar', 'Salem', 'Warangal', 'Guntur', 'Bhiwandi', 'Saharanpur',
    'Gorakhpur', 'Bikaner', 'Amravati', 'Noida', 'Jamshedpur', 'Bhilai', 'Cuttack', 'Firozabad', 'Kochi', 'Thiruvananthapuram',
    'Dehradun', 'Durgapur', 'Asansol', 'Nanded', 'Kolhapur', 'Ajmer', 'Gulbarga', 'Jamnagar', 'Ujjain', 'Siliguri',
    'Mangaluru', 'Belagavi', 'Tirunelveli', 'Gurugram', 'Udaipur', 'Vellore', 'Erode', 'Thrissur', 'Kozhikode', 'Puducherry',
    'Shimla', 'Panaji', 'Dharwad', 'Davangere', 'Shivamogga', 'Tumakuru', 'Dharmapuri', 'Hosur', 'Kambainallur',
];

const normalizeCity = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const titleCity = (s) => String(s).replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * Cities matching what the user has typed so far, best first: cities that have
 * posts, then names that start with the text, then names with a word that does,
 * then names containing it. Pure. `withPosts` are city keys (lower-case).
 */
export const matchCities = (query, withPosts = [], limit = 8) => {
    const q = normalizeCity(query);
    if (q.length < 1) return [];
    const have = new Set(withPosts.map(normalizeCity));
    const seen = new Set();
    const pool = [];
    for (const name of [...withPosts.map(titleCity), ...COMMON_CITIES]) {
        const key = normalizeCity(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pool.push({ name: titleCity(name), key, hasPosts: have.has(key) });
    }
    const tier = (c) => (c.key.startsWith(q) ? 0 : c.key.split(' ').some((w) => w.startsWith(q)) ? 1 : c.key.includes(q) ? 2 : 9);
    return pool
        .map((c) => ({ c, t: tier(c) }))
        .filter((x) => x.t < 9)
        .sort((a, b) => a.t - b.t || Number(b.c.hasPosts) - Number(a.c.hasPosts) || a.c.name.localeCompare(b.c.name))
        .slice(0, Math.max(1, limit))
        .map((x) => ({ name: x.c.name, hasPosts: x.c.hasPosts }));
};
