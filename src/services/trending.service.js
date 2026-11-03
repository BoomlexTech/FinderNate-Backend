import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { redisClient } from '../config/redis.config.js';
import { cityKey, discountOf, trendingScore } from '../utils/suggestions.utils.js';

/**
 * Trending topics (Phase 2 #58) and trending near you / hot deals (#42).
 *
 * Both are computed by jobs/trending.job.js (topics every 30 minutes, places
 * every 3 hours) and stored in Redis; the endpoints only read. If Redis has
 * nothing yet (first boot, Redis flushed), they compute once on demand.
 */

const HOUR = 60 * 60 * 1000;
export const TOPICS_KEY = 'fn:trending:topics';
export const placeKey = (city) => `fn:trending:place:${city || '_all'}`;
const TOPICS_TTL = 2 * 60 * 60;
const PLACE_TTL = 6 * 60 * 60;
const PER_PLACE = 30;
const MIN_CITY_POSTS = 3;

const publicLive = (since) => ({
    createdAt: { $gte: since },
    'settings.privacy': { $ne: 'private' },
    status: { $in: ['published', null] },
    postType: { $in: ['photo', 'reel', 'video', 'tweet'] },
    media: { $not: { $elemMatch: { type: 'video', processing: true } } },
});

export const computeTrendingTopics = async () => {
    // Last 24 hours, widened to 7 days when the platform is quiet.
    for (const hours of [24, 24 * 7]) {
        const rows = await Post.aggregate([
            { $match: { ...publicLive(new Date(Date.now() - hours * HOUR)), hashtags: { $exists: true, $ne: [] } } },
            { $project: { hashtags: 1, e: { $add: [{ $ifNull: ['$engagement.likes', 0] }, { $multiply: [2, { $ifNull: ['$engagement.comments', 0] }] }, { $multiply: [3, { $ifNull: ['$engagement.shares', 0] }] }] } } },
            { $unwind: '$hashtags' },
            { $group: { _id: '$hashtags', postCount: { $sum: 1 }, engagement: { $sum: '$e' } } },
            { $addFields: { score: { $add: [{ $multiply: ['$postCount', 5] }, '$engagement'] } } },
            { $sort: { score: -1 } },
            { $limit: 10 },
        ]);
        if (rows.length >= 5 || hours > 24) {
            const topics = rows.map((r) => ({ tag: r._id, postCount: r.postCount }));
            const value = { topics, updatedAt: new Date().toISOString(), windowHours: hours };
            try { await redisClient.set(TOPICS_KEY, JSON.stringify(value), 'EX', TOPICS_TTL); } catch { /* serve uncached */ }
            return value;
        }
    }
    return { topics: [], updatedAt: new Date().toISOString() };
};

export const getTrendingTopics = async () => {
    try {
        const cached = await redisClient.get(TOPICS_KEY);
        if (cached) return JSON.parse(cached);
    } catch { /* compute below */ }
    return computeTrendingTopics();
};

/**
 * Rank the last 7 days of public posts by decayed engagement, per city and
 * nationwide, plus the products on discount ("hot deals").
 */
export const computeTrendingPlaces = async () => {
    const since = new Date(Date.now() - 7 * 24 * HOUR);
    const posts = await Post.find(publicLive(since))
        .select('userId contentType createdAt engagement customization.product.price customization.product.originalPrice customization.product.location.city customization.service.location.city customization.business.location.city')
        .sort({ createdAt: -1 })
        .limit(20000)
        .lean();
    if (!posts.length) return { cities: 0 };

    // Author profile location as the fallback city.
    const needAuthor = [...new Set(posts.filter((p) => !cityKey(p.customization?.product?.location?.city || p.customization?.service?.location?.city || p.customization?.business?.location?.city)).map((p) => String(p.userId)))];
    const authors = needAuthor.length ? await User.find({ _id: { $in: needAuthor } }).select('location isAddressHidden').lean() : [];
    const authorCity = new Map(authors.map((a) => [String(a._id), a.isAddressHidden ? '' : cityKey(a.location)]));

    const now = Date.now();
    const byCity = new Map();
    const add = (city, bucket, entry) => {
        if (!byCity.has(city)) byCity.set(city, { trending: [], deals: [] });
        byCity.get(city)[bucket].push(entry);
    };
    for (const p of posts) {
        const c = p.customization || {};
        const city = cityKey(c.product?.location?.city || c.service?.location?.city || c.business?.location?.city) || authorCity.get(String(p.userId)) || '';
        const score = trendingScore(p.engagement || {}, (now - new Date(p.createdAt).getTime()) / HOUR);
        const entry = { id: String(p._id), score };
        add('_all', 'trending', entry);
        if (city) add(city, 'trending', entry);
        const discount = p.contentType === 'product' ? discountOf(c.product) : 0;
        if (discount >= 0.1) {
            const deal = { id: String(p._id), score: score * (1 + discount * 4), discount };
            add('_all', 'deals', deal);
            if (city) add(city, 'deals', deal);
        }
    }

    let written = 0;
    const pipeline = redisClient.pipeline();
    for (const [city, lists] of byCity) {
        if (city !== '_all' && lists.trending.length < MIN_CITY_POSTS) continue;
        const top = (arr) => arr.sort((a, b) => b.score - a.score).slice(0, PER_PLACE).map((e) => e.id);
        pipeline.set(placeKey(city === '_all' ? '' : city), JSON.stringify({
            trending: top(lists.trending),
            deals: top(lists.deals),
            updatedAt: new Date().toISOString(),
        }), 'EX', PLACE_TTL);
        written += 1;
    }
    try { await pipeline.exec(); } catch { /* next run retries */ }
    return { cities: written - 1 };
};

/** Ids for a city (falls back to nationwide when the city has too little). */
export const getTrendingPlaceIds = async (city) => {
    const read = async (key) => {
        try {
            const raw = await redisClient.get(key);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    };
    let local = city ? await read(placeKey(city)) : null;
    let all = await read(placeKey(''));
    if (!all) {
        await computeTrendingPlaces();
        all = await read(placeKey(''));
        if (city) local = await read(placeKey(city));
    }
    return { local, all };
};
