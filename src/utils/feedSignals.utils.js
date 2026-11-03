import mongoose from 'mongoose';
import NotInterested from '../models/notInterested.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import { User } from '../models/user.models.js';
import { redisClient } from '../config/redis.config.js';
import { RANK_SHIFTS, buildSignalSets, hasRankSignals, rankTimeExpression } from './feedRanking.rules.js';

export { RANK_SHIFTS, buildSignalSets, hasRankSignals, rankTimeExpression };

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


const SIGNALS_TTL_SECONDS = 10 * 60;
const signalsKey = (userId) => `fn:feedsig:${userId}`;


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
