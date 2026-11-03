import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import Block from '../models/block.models.js';
import { getFollowingIdSet } from '../utils/followEngagement.utils.js';
import { canBeMentioned } from '../utils/mentions.utils.js';
import { getContentCategoryList } from './discovery.controllers.js';
import { cleanTagQuery, escapeRegex, tagsInText, candidateWords, mergeTagSuggestions } from '../utils/suggestions.utils.js';

/**
 * Suggestions while writing a post (Phase 2 #11) and hashtag suggestions for
 * a caption (#45). Built from the platform's own posts: no outside service.
 */

const DAY = 24 * 60 * 60 * 1000;
const LIMIT = 10;
const publicRecent = (days) => ({ createdAt: { $gte: new Date(Date.now() - days * DAY) }, 'settings.privacy': { $ne: 'private' } });

const topTags = async (match, limit = LIMIT, tagFilter = null) => {
    const rows = await Post.aggregate([
        { $match: match },
        { $project: { hashtags: 1 } },
        { $unwind: '$hashtags' },
        ...(tagFilter ? [{ $match: { hashtags: tagFilter } }] : []),
        { $group: { _id: '$hashtags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
    ]);
    return rows.map((r) => ({ tag: r._id, count: r.count }));
};

const suggestHashtags = async (q) => {
    const term = cleanTagQuery(q);
    if (!term) return topTags(publicRecent(7));
    const prefix = new RegExp(`^${escapeRegex(term)}`);
    return topTags({ ...publicRecent(180), hashtags: prefix }, LIMIT, prefix);
};

const suggestMentions = async (q, viewerId) => {
    const term = String(q ?? '').replace(/^@+/, '').trim().toLowerCase();
    if (!term) return [];
    const re = new RegExp(`^${escapeRegex(term)}`);
    const candidates = await User.find({
        $or: [{ username: re }, { fullNameLower: re }],
        _id: { $ne: viewerId },
        isDeleted: { $ne: true },
        accountStatus: 'active',
        mentionPrivacy: { $ne: 'nobody' },
    }).select('username fullName profileImageUrl mentionPrivacy').limit(30).lean();
    if (!candidates.length) return [];

    const [following, blocks] = await Promise.all([
        getFollowingIdSet(viewerId),
        Block.find({ $or: [{ blockerId: viewerId }, { blockedId: viewerId }] }).select('blockerId blockedId').lean(),
    ]);
    const blocked = new Set(blocks.flatMap((b) => [String(b.blockerId), String(b.blockedId)]));
    const out = [];
    for (const c of candidates) {
        const followsAuthor = c.mentionPrivacy === 'following' ? (await getFollowingIdSet(c._id)).has(String(viewerId)) : false;
        if (!canBeMentioned({ mentionPrivacy: c.mentionPrivacy, followsAuthor, blocked: blocked.has(String(c._id)) })) continue;
        out.push({ _id: c._id, username: c.username, fullName: c.fullName, profileImageUrl: c.profileImageUrl, isFollowing: following.has(String(c._id)) });
    }
    // People you follow first, then by username.
    return out.sort((a, b) => (b.isFollowing - a.isFollowing) || a.username.localeCompare(b.username)).slice(0, LIMIT);
};

const suggestCategories = async (q) => {
    const term = String(q ?? '').trim().toLowerCase();
    const list = await getContentCategoryList();
    const starts = list.filter((c) => c.toLowerCase().startsWith(term));
    const contains = list.filter((c) => !starts.includes(c) && c.toLowerCase().includes(term));
    return [...starts, ...contains].slice(0, term ? LIMIT : list.length);
};

const suggestSubcategories = async (q, category) => {
    const term = String(q ?? '').trim();
    const match = { ...publicRecent(365), subcategories: { $exists: true, $ne: [] } };
    if (category) match.category = new RegExp(`^${escapeRegex(String(category).trim())}$`, 'i');
    const termRe = term ? new RegExp(`^${escapeRegex(term)}`, 'i') : null;
    const rows = await Post.aggregate([
        { $match: match },
        { $project: { subcategories: 1 } },
        { $unwind: '$subcategories' },
        ...(termRe ? [{ $match: { subcategories: termRe } }] : []),
        { $group: { _id: { $toLower: '$subcategories' }, label: { $first: '$subcategories' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: LIMIT },
    ]);
    return rows.map((r) => ({ label: r.label, count: r.count }));
};

/**
 * GET /suggestions/compose?type=hashtag|mention|category|subcategory&q=&category=
 */
export const getComposeSuggestions = asyncHandler(async (req, res) => {
    const { type = 'hashtag', q = '', category } = req.query;
    let items = [];
    if (type === 'mention') items = await suggestMentions(q, req.user._id);
    else if (type === 'category') items = await suggestCategories(q);
    else if (type === 'subcategory') items = await suggestSubcategories(q, category);
    else items = await suggestHashtags(q);
    return res.status(200).json(new ApiResponse(200, { type, items }, 'Suggestions'));
});

/**
 * POST /suggestions/hashtags { caption, category } — tags for this post:
 * tags often used with the ones already typed, popular tags in the chosen
 * category, caption words that are popular tags, then what's trending.
 */
export const suggestHashtagsForPost = asyncHandler(async (req, res) => {
    const caption = String(req.body?.caption ?? '').slice(0, 3000);
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
    const used = tagsInText(caption);
    const words = candidateWords(caption);

    const [related, inCategory, fromWords, trending] = await Promise.all([
        used.length ? topTags({ ...publicRecent(180), hashtags: { $in: used } }, 20) : Promise.resolve([]),
        category ? topTags({ ...publicRecent(60), category: new RegExp(`^${escapeRegex(category)}$`, 'i') }, 20) : Promise.resolve([]),
        words.length ? topTags({ ...publicRecent(180), hashtags: { $in: words } }, 20, { $in: words }) : Promise.resolve([]),
        topTags(publicRecent(3), 10),
    ]);

    const suggestions = mergeTagSuggestions([
        { name: 'related', tags: related.map((t) => t.tag) },
        { name: 'caption', tags: fromWords.filter((t) => t.count >= 2).map((t) => t.tag) },
        { name: 'category', tags: inCategory.map((t) => t.tag) },
        { name: 'trending', tags: trending.map((t) => t.tag) },
    ], used);

    return res.status(200).json(new ApiResponse(200, { suggestions }, 'Hashtag suggestions'));
});

