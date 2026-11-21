/**
 * A stable "random" order for paginated feeds.
 *
 * The Explore feed used to shuffle its whole candidate list with Math.random
 * on every request and then slice out page N. Each page came from a different
 * shuffle, so page 2 repeated posts already shown on page 1 and left others
 * out entirely (seen in the app on 21 Nov 2026: the same posts twice in the
 * Explore grid).
 *
 * Here every post gets a position from a hash of (session seed, post id). All
 * pages of one browsing session therefore come from the same order, and a
 * post published between two page requests only slots in at its own place
 * instead of reshuffling everything around it.
 */

/** 32-bit FNV-1a hash of a string. */
export const hashString = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

/** How long one session's order lasts when the client sends no seed. */
export const FEED_SEED_WINDOW_MS = 30 * 60 * 1000;

/**
 * The seed for one viewer's browsing session: the client's own `seed` when it
 * sends one (a fresh one per pull-to-refresh), else the current 30-minute
 * window, so clients that send none still page through one stable order. The
 * viewer is part of it so two people do not see the same order.
 */
export const feedSeed = ({ viewerId, clientSeed, now = Date.now() }) => {
    const raw = clientSeed == null ? '' : String(clientSeed).trim().slice(0, 64);
    const session = raw || `w${Math.floor(now / FEED_SEED_WINDOW_MS)}`;
    return `${viewerId || 'guest'}:${session}`;
};

/**
 * Returns a shuffle function for [seed]: it orders items by the hash of
 * (seed, idOf(item)), so the same seed always gives the same order.
 */
export const seededShuffler = (seed, idOf = (item) => item?._id) => (items) =>
    items
        .map((item) => ({ item, key: hashString(`${seed}|${String(idOf(item))}`) }))
        .sort((a, b) => a.key - b.key)
        .map(({ item }) => item);
