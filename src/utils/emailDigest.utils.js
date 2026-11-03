import crypto from 'node:crypto';

/**
 * Daily email digest (Phase 2 #10). Pure helpers.
 *
 * Instead of one email per like or comment, people get at most one summary a
 * day of what they haven't seen yet in the app. Each category can be turned
 * off in Settings or with the unsubscribe link in the email itself.
 */

export const DIGEST_CATEGORIES = ['activity', 'messages'];

/** Notification types summarised under "activity", and how they read. */
export const DIGEST_GROUPS = [
    { key: 'likes', types: ['like', 'story_like'], one: 'new like', many: 'new likes' },
    { key: 'comments', types: ['comment', 'story_comment'], one: 'new comment', many: 'new comments' },
    { key: 'follows', types: ['follow'], one: 'new follower', many: 'new followers' },
    { key: 'mentions', types: ['mention', 'tag'], one: 'mention', many: 'mentions' },
    { key: 'collabs', types: ['collab_invite', 'collab_accepted', 'repost'], one: 'collab or share update', many: 'collab and share updates' },
    { key: 'milestones', types: ['milestone'], one: 'listing milestone', many: 'listing milestones' },
];
export const DIGEST_TYPES = DIGEST_GROUPS.flatMap((g) => g.types);

/** { type: count } → the lines of the email, biggest first. */
export const digestLines = (countsByType = {}, unreadMessages = 0) => {
    const lines = DIGEST_GROUPS
        .map((g) => ({ g, n: g.types.reduce((sum, t) => sum + (Number(countsByType[t]) || 0), 0) }))
        .filter(({ n }) => n > 0)
        .sort((a, b) => b.n - a.n)
        .map(({ g, n }) => `${n} ${n === 1 ? g.one : g.many}`);
    if (unreadMessages > 0) lines.push(`${unreadMessages} unread ${unreadMessages === 1 ? 'message' : 'messages'}`);
    return lines;
};

const secret = () => process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.ACCESS_TOKEN_SECRET || 'findernate-unsubscribe';

/** Signed token for an unsubscribe link: only valid for this user and category. */
export const unsubscribeToken = (userId, category) => crypto
    .createHmac('sha256', secret())
    .update(`${userId}:${category}`)
    .digest('base64url');

export const verifyUnsubscribeToken = (userId, category, token) => {
    if (!userId || !DIGEST_CATEGORIES.includes(category) || typeof token !== 'string') return false;
    const expected = Buffer.from(unsubscribeToken(String(userId), category));
    const given = Buffer.from(token);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

export const unsubscribeUrl = (userId, category) => {
    const base = (process.env.BACKEND_URL || 'https://apis.findernate.com').replace(/\/+$/, '');
    const qs = new URLSearchParams({ u: String(userId), c: category, t: unsubscribeToken(String(userId), category) });
    return `${base}/api/v1/email/unsubscribe?${qs}`;
};
