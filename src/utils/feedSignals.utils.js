import mongoose from 'mongoose';
import NotInterested from '../models/notInterested.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { User } from '../models/user.models.js';
import { redisClient } from '../config/redis.config.js';

/**
 * Per-viewer feed signals (Phase 2 #26 and #68).
 *
 * Feeds stay newest-first; these signals only move a post earlier or later by
 * treating it as if it had been posted at a different time ("rank time"):
 *   + preferred category ........ 12 hours newer
 *   - author marked not interested 3 days older
 *   - category marked ........... 1 day older
 *   - each repeated hashtag ...... 12 hours older (at most 2 days)
 * and the posts marked "Not interested" (or hidden) are left out entirely.
 * This keeps pagination stable and needs no scoring service.
 */

const HOUR = 60 * 60 * 1000;
export const RANK_SHIFTS = Object.freeze({
    preferredCategory: 12 * HOUR,
    author: 72 * HOUR,
    category: 24 * HOUR,
    hashtag: 12 * HOUR,
    maxHashtags: 4,
});

const SIGNALS_TTL_SECONDS = 10 * 60;
const MAX_EXCLUDED = 1000;
const signalsKey = (userId) => `fn:feedsig:${userId}`;

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

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

export const hasRankSignals = (signals) => !!signals && (
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

const EMPTY = Object.freeze({ excludedPostIds: [], authorIds: [], categories: [], hashtags: [], preferredCategories: [] });

/** The viewer's signals, cached for 10 minutes. Never throws. */
export const getFeedSignals = async (userId) => {
    if (!userId) return EMPTY;
    const key = signalsKey(userId);
    try {
        const cached = await redisClient.get(key);
        if (cached) return JSON.parse(cached);
    } catch { /* fall through to the database */ }

    try {
        const [notInterested, hidden, user] = await Promise.all([
            NotInterested.find({ userId }).sort({ createdAt: -1 }).limit(500)
                .select('postId authorId category hashtags').lean(),
            PostInteraction.find({ userId, interactionType: 'hide', isHidden: true })
                .sort({ lastInteracted: -1 }).limit(500).select('postId').lean(),
            User.findById(userId).select('preferredCategories').lean(),
        ]);
        const signals = buildSignalSets({
            notInterested,
            hiddenPostIds: hidden.map((h) => h.postId),
            preferredCategories: user?.preferredCategories || [],
        });
        try { await redisClient.set(key, JSON.stringify(signals), 'EX', SIGNALS_TTL_SECONDS); } catch { /* optional */ }
        return signals;
    } catch {
        return EMPTY;
    }
};

export const invalidateFeedSignals = async (userId) => {
    try { await redisClient.del(signalsKey(userId)); } catch { /* expires anyway */ }
};

/** Excluded ids as ObjectIds, for $nin. */
export const excludedObjectIds = (signals) => (signals?.excludedPostIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
