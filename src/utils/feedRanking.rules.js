import mongoose from 'mongoose';

/** Pure ranking rules behind utils/feedSignals.utils.js (Phase 2 #26, #68). */

const HOUR = 60 * 60 * 1000;
const MAX_EXCLUDED = 1000;
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

export const RANK_SHIFTS = Object.freeze({
    preferredCategory: 12 * HOUR,
    author: 72 * HOUR,
    category: 24 * HOUR,
    hashtag: 12 * HOUR,
    maxHashtags: 4,
});

/**
 * Turn not-interested rows into the sets the ranking needs. Pure.
 * A hashtag counts only when it appears on two or more marked posts, so one
 * dismissed post can't bury a common tag.
 */
export const buildSignalSets = ({ notInterested = [], hiddenPostIds = [], preferredCategories = [] }) => {
    const excluded = new Set();
    const authors = new Set();
    const categories = new Set();
    const tagCounts = new Map();

    for (const row of notInterested) {
        if (row.postId) excluded.add(String(row.postId));
        if (row.authorId) authors.add(String(row.authorId));
        const cat = lower(row.category);
        if (cat) categories.add(cat);
        for (const tag of row.hashtags || []) {
            const t = lower(tag);
            if (t) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        }
    }
    for (const id of hiddenPostIds) excluded.add(String(id));

    const preferred = [...new Set(preferredCategories.map(lower).filter(Boolean))];
    // A category the viewer explicitly asked for is never also penalised.
    for (const p of preferred) categories.delete(p);

    return {
        excludedPostIds: [...excluded].slice(0, MAX_EXCLUDED),
        authorIds: [...authors],
        categories: [...categories],
        hashtags: [...tagCounts].filter(([, n]) => n >= 2).map(([t]) => t),
        preferredCategories: preferred,
    };
};

export const hasRankSignals = (signals) => !!signals && !!(
    signals.authorIds?.length || signals.categories?.length || signals.hashtags?.length || signals.preferredCategories?.length
);

/**
 * Aggregation expression for a post's rank time, or null when nothing shifts
 * anything (callers then keep sorting by createdAt). Pure.
 */
export const rankTimeExpression = (signals, { toObjectId = (id) => new mongoose.Types.ObjectId(id) } = {}) => {
    if (!hasRankSignals(signals)) return null;
    const category = { $toLower: { $ifNull: ['$category', ''] } };
    const terms = [];
    if (signals.preferredCategories.length) {
        terms.push({ $cond: [{ $in: [category, signals.preferredCategories] }, RANK_SHIFTS.preferredCategory, 0] });
    }
    if (signals.authorIds.length) {
        terms.push({ $cond: [{ $in: ['$userId', signals.authorIds.map(toObjectId)] }, -RANK_SHIFTS.author, 0] });
    }
    if (signals.categories.length) {
        terms.push({ $cond: [{ $in: [category, signals.categories] }, -RANK_SHIFTS.category, 0] });
    }
    if (signals.hashtags.length) {
        terms.push({
            $multiply: [-RANK_SHIFTS.hashtag, {
                $min: [RANK_SHIFTS.maxHashtags, { $size: { $setIntersection: [{ $ifNull: ['$hashtags', []] }, signals.hashtags] } }],
            }],
        });
    }
    return { $add: ['$createdAt', ...terms] };
};
