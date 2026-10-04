/**
 * Pure helpers for business Insights: date windows, tier sections, percentage
 * change, ranking, pagination and CSV output. Nothing here touches the database
 * or Redis, so every function can be tested on its own.
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;
// Mongo's date operators take a fixed offset as well as a zone name. India has
// no daylight saving, so the offset is exact and does not depend on the server
// having a timezone database.
export const IST_MONGO_TIMEZONE = '+05:30';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_OPTIONS = [7, 30, 90];
export const DEFAULT_RANGE_DAYS = 30;

// Per-post sections look at the newest posts only, so no account can trigger an
// unbounded scan however many posts it has.
export const POST_ANALYSIS_CAP = 2000;
export const TOP_POSTS_LIMIT = 20;
export const POSTS_PAGE_MAX = 50;
export const POSTS_PAGE_DEFAULT = 20;

// PostInteraction rows (the only record of a share) expire 90 days after the
// share, so a comparison window reaching further back has no share data.
export const SHARE_RETENTION_DAYS = 90;

// Fewer engagement events than this and "best hour" is noise, not a finding.
export const MIN_EVENTS_FOR_BEST_TIME = 10;

const TIER_RANK = { free: 0, small_business: 1, corporate: 2 };

// The tier each section needs. The order is the order clients show upsells in.
const SECTION_TIERS = {
    dailyTrend: 'small_business',
    topPosts: 'small_business',
    savesShares: 'small_business',
    leads: 'small_business',
    comparison: 'corporate',
    insights: 'corporate',
    allPosts: 'corporate',
    export: 'corporate'
};

export const tierAtLeast = (tier, required) => (TIER_RANK[tier] ?? 0) >= TIER_RANK[required];

export const getLockedSections = (tier) =>
    Object.entries(SECTION_TIERS)
        .filter(([, requiredTier]) => !tierAtLeast(tier, requiredTier))
        .map(([section, requiredTier]) => ({ section, requiredTier }));

/**
 * The number of days to report on. Only 7, 30 and 90 are offered; anything else
 * (or nothing) gets the default. A valid range above the plan's maximum is
 * clamped down to it rather than refused, so a stale client still gets a view.
 */
export const resolveRange = (raw, maxDays) => {
    const requested = Number.parseInt(raw, 10);
    if (!RANGE_OPTIONS.includes(requested)) return Math.min(DEFAULT_RANGE_DAYS, maxDays);
    return Math.min(requested, maxDays);
};

/** 'YYYY-MM-DD' of the calendar day a moment falls on in India. */
export const istDayKey = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The reporting window: `days` calendar days in IST ending now (so today counts,
 * part-way through), plus an equally long window immediately before it for
 * comparisons. Both are plain Date bounds; `dayKeys` lists the IST days of the
 * current window oldest first so series can be zero-filled.
 */
export const buildWindow = (days, now = new Date()) => {
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    const start = new Date(
        Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - (days - 1)) - IST_OFFSET_MS
    );
    const length = now.getTime() - start.getTime();
    return {
        days,
        start,
        end: now,
        previousStart: new Date(start.getTime() - length),
        previousEnd: start,
        dayKeys: Array.from({ length: days }, (_, i) => istDayKey(new Date(start.getTime() + i * DAY_MS)))
    };
};

export const canCompareShares = (window, now = new Date()) =>
    window.previousStart.getTime() >= now.getTime() - SHARE_RETENTION_DAYS * DAY_MS;

/** Percent change to one decimal; null when there is nothing to divide by. */
export const pctChange = (value, previous) => {
    if (!previous) return value ? null : 0;
    return Math.round(((value - previous) / previous) * 1000) / 10;
};

export const comparisonMetric = (value, previous) => ({ value, previous, pctChange: pctChange(value, previous) });

const toCountMap = (rows) => new Map((rows || []).map((row) => [row._id, row.n]));

/** One row per day, zero-filled, from per-day count lists keyed by metric. */
export const buildDailySeries = (dayKeys, byDay) => {
    const maps = Object.fromEntries(Object.entries(byDay).map(([metric, rows]) => [metric, toCountMap(rows)]));
    return dayKeys.map((date) => ({
        date,
        newFollowers: maps.newFollowers.get(date) || 0,
        likes: maps.likes.get(date) || 0,
        comments: maps.comments.get(date) || 0,
        saves: maps.saves.get(date) || 0,
        shares: maps.shares.get(date) || 0
    }));
};

/** Running total of new followers across the window. Churn is not recorded, so this is gains only. */
export const buildFollowerGrowth = (series) => {
    let cumulative = 0;
    return series.map(({ date, newFollowers }) => {
        cumulative += newFollowers;
        return { date, newFollowers, cumulative };
    });
};

/** Sum several `[{ _id: slot, n }]` lists into `size` slots, `_id` minus `base` being the slot. */
export const sumIntoSlots = (lists, size, base = 0) => {
    const slots = Array(size).fill(0);
    for (const list of lists) {
        for (const { _id, n } of list || []) {
            const slot = _id - base;
            if (slot >= 0 && slot < size) slots[slot] += n;
        }
    }
    return slots;
};

/** The busiest slot, or null when there is too little activity to call one. Ties go to the earliest slot. */
export const busiestSlot = (slots) => {
    const total = slots.reduce((sum, n) => sum + n, 0);
    if (total < MIN_EVENTS_FOR_BEST_TIME) return null;
    let best = 0;
    slots.forEach((n, i) => {
        if (n > slots[best]) best = i;
    });
    return { index: best, count: slots[best] };
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CAPTION_SNIPPET_LENGTH = 120;

export const captionSnippet = (post) => {
    const text = String(post.caption || post.description || '').replace(/\s+/g, ' ').trim();
    return text.length > CAPTION_SNIPPET_LENGTH ? `${text.slice(0, CAPTION_SNIPPET_LENGTH - 1)}…` : text;
};

const thumbnailOf = (post) => {
    const media = post.media?.[0];
    if (!media) return null;
    return media.thumbnailUrl || (media.type === 'image' ? media.url : null) || null;
};

/** The per-post shape shared by top posts, the full list and the CSV. */
export const buildPostRow = (post, counts) => {
    const { likes = 0, comments = 0, saves = 0, shares = 0 } = counts || {};
    return {
        id: String(post._id),
        thumbnailUrl: thumbnailOf(post),
        caption: captionSnippet(post),
        contentType: post.contentType || null,
        postType: post.postType || null,
        createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
        window: { likes, comments, saves, shares, total: likes + comments + saves + shares },
        lifetime: {
            likes: post.engagement?.likes || 0,
            comments: post.engagement?.comments || 0,
            shares: post.engagement?.shares || 0
        }
    };
};

export const POST_SORTS = {
    total: (row) => row.window.total,
    likes: (row) => row.window.likes,
    comments: (row) => row.window.comments,
    saves: (row) => row.window.saves,
    shares: (row) => row.window.shares,
    newest: (row) => new Date(row.createdAt).getTime() || 0
};

export const resolveSort = (raw) => (Object.hasOwn(POST_SORTS, raw) ? raw : 'total');

/** Highest first; equal scores keep the newer post ahead. */
export const sortRows = (rows, sort) => {
    const pick = POST_SORTS[resolveSort(sort)];
    return [...rows].sort((a, b) => pick(b) - pick(a) || POST_SORTS.newest(b) - POST_SORTS.newest(a));
};

export const topPosts = (rows, limit = TOP_POSTS_LIMIT) =>
    sortRows(rows.filter((row) => row.window.total > 0), 'total').slice(0, limit);

const clampInt = (raw, min, max, fallback) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
};

export const parsePaging = (query) => ({
    page: clampInt(query.page, 1, Number.MAX_SAFE_INTEGER, 1),
    limit: clampInt(query.limit, 1, POSTS_PAGE_MAX, POSTS_PAGE_DEFAULT)
});

export const paginate = (items, page, limit) => ({
    items: items.slice((page - 1) * limit, page * limit),
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / limit))
});

/** Engagement summed by `rows[key]` (post type or content type). Average is per post of that kind. */
export const buildTypeBreakdown = (rows, key) => {
    const groups = new Map();
    for (const row of rows) {
        const name = row[key] || 'unknown';
        const group = groups.get(name) || { key: name, posts: 0, likes: 0, comments: 0, saves: 0, shares: 0, total: 0 };
        group.posts += 1;
        group.likes += row.window.likes;
        group.comments += row.window.comments;
        group.saves += row.window.saves;
        group.shares += row.window.shares;
        group.total += row.window.total;
        groups.set(name, group);
    }
    return [...groups.values()]
        .map((group) => ({ ...group, avgPerPost: Math.round((group.total / group.posts) * 10) / 10 }))
        .sort((a, b) => b.total - a.total || b.posts - a.posts);
};

export const bestPostType = (breakdown) => {
    const ranked = breakdown.filter((group) => group.total > 0).sort((a, b) => b.avgPerPost - a.avgPerPost || b.total - a.total);
    return ranked.length ? { key: ranked[0].key, avgPerPost: ranked[0].avgPerPost, posts: ranked[0].posts } : null;
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * One CSV cell. Text is always safe to open in a spreadsheet: a leading = + - @
 * tab or CR would be run as a formula (a caption is attacker-controlled), so it
 * is prefixed with an apostrophe, and quotes, commas and line breaks are
 * quoted with embedded quotes doubled. Numbers pass through untouched, so a
 * negative count stays a number.
 */
export const csvCell = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvLine = (values) => values.map(csvCell).join(',');

export const buildInsightsCsv = ({ payload, rows }) => {
    const lines = [
        csvLine(['Findernate Insights', `${payload.period.from} to ${payload.period.to} (India time)`]),
        '',
        csvLine(['Daily summary']),
        csvLine(['Date', 'New followers', 'Likes', 'Comments', 'Saves', 'Shares']),
        ...payload.series.map((day) => csvLine([day.date, day.newFollowers, day.likes, day.comments, day.saves, day.shares])),
        '',
        csvLine(['Posts']),
        csvLine([
            'Post ID', 'Posted on', 'Post type', 'Content type', 'Caption',
            'Likes in period', 'Comments in period', 'Saves in period', 'Shares in period', 'Total in period',
            'Lifetime likes', 'Lifetime comments', 'Lifetime shares'
        ]),
        ...rows.map((row) => csvLine([
            row.id, row.createdAt ? istDayKey(new Date(row.createdAt)) : '', row.postType, row.contentType, row.caption,
            row.window.likes, row.window.comments, row.window.saves, row.window.shares, row.window.total,
            row.lifetime.likes, row.lifetime.comments, row.lifetime.shares
        ]))
    ];
    // The BOM makes Excel read the file as UTF-8, so captions in other scripts survive.
    return `﻿${lines.join('\r\n')}\r\n`;
};
