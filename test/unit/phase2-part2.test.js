import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMentionUsernames, canBeMentioned } from '../../src/utils/mentions.rules.js';
import { normalizeSubcategories, classifyAspect, normalizeCrop, applyMediaLayout, normalizeCollaboratorIds } from '../../src/utils/postExtras.utils.js';
import { buildSignalSets, rankTimeExpression, hasRankSignals, RANK_SHIFTS } from '../../src/utils/feedRanking.rules.js';
import { milestonesToAnnounce } from '../../src/utils/viewMilestones.rules.js';
import { shapeStoryEngagement, isStoryLive } from '../../src/utils/storyEngagement.utils.js';
import { seenFlagsFor, FRESH_WINDOW_MS } from '../../src/utils/seenFlags.utils.js';
import { cleanTagQuery, tagsInText, candidateWords, mergeTagSuggestions, cityKey, discountOf, trendingScore } from '../../src/utils/suggestions.utils.js';
import { digestLines, unsubscribeToken, verifyUnsubscribeToken } from '../../src/utils/emailDigest.utils.js';
import { binPreviewOf, mediaUrlsOf, restoredStoryState } from '../../src/utils/bin.rules.js';

const OID = '64b7f0c2a1b2c3d4e5f60718';
const OID2 = '64b7f0c2a1b2c3d4e5f60719';

test('#64 mentions: usernames are found, emails are not', () => {
    assert.deepEqual(
        extractMentionUsernames('hi @Asha and @rahul.k, mail me at x@y.com @asha'),
        ['asha', 'rahul.k'],
    );
    assert.deepEqual(extractMentionUsernames('no mentions here', null), []);
    assert.deepEqual(extractMentionUsernames('@a. trailing dot'), ['a']);
});

test('#64 mention privacy rules', () => {
    assert.equal(canBeMentioned({ mentionPrivacy: 'everyone' }), true);
    assert.equal(canBeMentioned({ mentionPrivacy: 'nobody' }), false);
    assert.equal(canBeMentioned({ mentionPrivacy: 'following', followsAuthor: false }), false);
    assert.equal(canBeMentioned({ mentionPrivacy: 'following', followsAuthor: true }), true);
    assert.equal(canBeMentioned({ mentionPrivacy: 'everyone', blocked: true }), false);
    assert.equal(canBeMentioned({ mentionPrivacy: 'everyone', isSelf: true }), false);
});

test('#17 subcategories: trimmed, de-duplicated, at most 10', () => {
    assert.equal(normalizeSubcategories(undefined), undefined);
    assert.deepEqual(normalizeSubcategories(' Shoes , shoes,  Running   Shoes ,,'), ['Shoes', 'Running Shoes']);
    assert.deepEqual(normalizeSubcategories('["A","b","a"]'), ['A', 'b']);
    const many = Array.from({ length: 15 }, (_, i) => `s${i}`);
    assert.equal(normalizeSubcategories(many).length, 10);
    assert.deepEqual(normalizeSubcategories(['x'.repeat(41), 'ok']), ['ok']);
});

test('#3 aspect classification uses the midpoints', () => {
    assert.equal(classifyAspect(1080, 1350), '4:5');
    assert.equal(classifyAspect(1080, 1210), '4:5');   // r = 0.8926
    assert.equal(classifyAspect(1080, 1200), '1:1');   // r = 0.9
    assert.equal(classifyAspect(1382, 1000), '1:1');
    assert.equal(classifyAspect(1383, 1000), '1.91:1');
    assert.equal(classifyAspect(1920, 1080, { isVibe: true }), '9:16');
    assert.equal(classifyAspect(0, 100), null);
});

test('#3 video crop window is kept inside the frame', () => {
    assert.deepEqual(normalizeCrop({ x: 0.1, y: 0.2, width: 0.8, height: 0.9 }), { x: 0.1, y: 0.2, width: 0.8, height: 0.8 });
    assert.equal(normalizeCrop({ x: 0, y: 0, width: 0, height: 1 }), undefined);
    assert.equal(normalizeCrop('nope'), undefined);
});

test('#3 media layout: carousel takes the first item format, crop only on video', () => {
    const media = [
        { type: 'image', dimensions: { width: 1000, height: 1000 } },
        { type: 'video', dimensions: { width: 1920, height: 1080 } },
    ];
    const out = applyMediaLayout(media, JSON.stringify({ aspect: '4:5', items: [{ crop: { x: 0, y: 0, width: 1, height: 1 } }, { crop: { x: 0.2, y: 0, width: 0.5, height: 1 } }] }));
    assert.equal(out[0].aspect, '4:5');
    assert.equal(out[1].aspect, '4:5');
    assert.equal(out[0].crop, undefined);
    assert.deepEqual(out[1].crop, { x: 0.2, y: 0, width: 0.5, height: 1 });
    // Older clients send nothing: inferred from the first item.
    assert.equal(applyMediaLayout(media, undefined)[0].aspect, '1:1');
    assert.equal(applyMediaLayout(media, undefined, { isVibe: true })[1].aspect, '9:16');
});

test('#50 collaborator ids: valid, distinct, not the owner, max 3', () => {
    const isValid = (id) => /^[a-f0-9]{24}$/.test(id);
    const ids = normalizeCollaboratorIds(JSON.stringify([OID, OID, 'bad', OID2, { _id: '64b7f0c2a1b2c3d4e5f6071a' }, '64b7f0c2a1b2c3d4e5f6071b']), OID2, isValid);
    assert.deepEqual(ids, [OID, '64b7f0c2a1b2c3d4e5f6071a', '64b7f0c2a1b2c3d4e5f6071b']);
});

test('#68/#26 feed signals', () => {
    const signals = buildSignalSets({
        notInterested: [
            { postId: 'p1', authorId: 'a1', category: 'Comedy', hashtags: ['fun', 'meme'] },
            { postId: 'p2', authorId: 'a2', category: 'Sports', hashtags: ['meme'] },
        ],
        hiddenPostIds: ['p3'],
        preferredCategories: ['Sports', 'Music'],
    });
    assert.deepEqual(signals.excludedPostIds.sort(), ['p1', 'p2', 'p3']);
    assert.deepEqual(signals.authorIds.sort(), ['a1', 'a2']);
    // Sports is preferred, so it is never also penalised.
    assert.deepEqual(signals.categories, ['comedy']);
    // Only tags seen on two or more dismissed posts.
    assert.deepEqual(signals.hashtags, ['meme']);
    assert.deepEqual(signals.preferredCategories, ['sports', 'music']);
    assert.equal(hasRankSignals(signals), true);

    const expr = rankTimeExpression(signals, { toObjectId: (id) => `oid:${id}` });
    assert.equal(expr.$add[0], '$createdAt');
    assert.equal(expr.$add.length, 5);
    assert.equal(expr.$add[1].$cond[1], RANK_SHIFTS.preferredCategory);
    assert.deepEqual(expr.$add[2].$cond[0].$in[1], ['oid:a1', 'oid:a2']);

    assert.equal(rankTimeExpression(buildSignalSets({})), null);
});

test('#46 milestones announced once each, in order', () => {
    assert.deepEqual(milestonesToAnnounce(120, [50, 100, 500], []), [50, 100]);
    assert.deepEqual(milestonesToAnnounce(120, [500, 100, 50], [50]), [100]);
    assert.deepEqual(milestonesToAnnounce(49, [50, 100, 500], []), []);
    assert.deepEqual(milestonesToAnnounce(600, [50, 100, 500], [50, 100, 500]), []);
});

test('#32 story engagement: likedBy never leaves the server, comments count owner-only', () => {
    const viewer = { likedBy: [OID, OID2], commentsCount: 3, autoArchivedAt: new Date() };
    shapeStoryEngagement(viewer, OID, false);
    assert.equal(viewer.likesCount, 2);
    assert.equal(viewer.isLiked, true);
    assert.equal('likedBy' in viewer, false);
    assert.equal('commentsCount' in viewer, false);
    assert.equal('autoArchivedAt' in viewer, false);

    const owner = { likedBy: [OID2], commentsCount: 3 };
    shapeStoryEngagement(owner, OID, true);
    assert.equal(owner.isLiked, false);
    assert.equal(owner.commentsCount, 3);

    const now = new Date('2026-11-03T10:00:00Z');
    assert.equal(isStoryLive({ isArchived: false, expiresAt: new Date('2026-11-03T11:00:00Z') }, now), true);
    assert.equal(isStoryLive({ isArchived: true, expiresAt: new Date('2026-11-03T11:00:00Z') }, now), false);
    assert.equal(isStoryLive({ isArchived: false, expiresAt: new Date('2026-11-03T09:00:00Z') }, now), false);
});

test('#33 seen and fresh flags', () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    const recent = { _id: 'p1', createdAt: new Date(now - 60 * 60 * 1000) };
    const old = { _id: 'p2', createdAt: new Date(now - FRESH_WINDOW_MS - 1) };
    assert.deepEqual(seenFlagsFor(recent, new Set(), now), { isSeen: false, isFresh: true });
    assert.deepEqual(seenFlagsFor(recent, new Set(['p1']), now), { isSeen: true, isFresh: false });
    assert.deepEqual(seenFlagsFor(old, new Set(), now), { isSeen: false, isFresh: false });
    assert.deepEqual(seenFlagsFor({ id: 'p3' }, new Set(['p3']), now), { isSeen: true, isFresh: false });
});

test('#11/#45 suggestion helpers', () => {
    assert.equal(cleanTagQuery('#Street-Food!'), 'streetfood');
    assert.deepEqual(tagsInText('Loved it #Food #food #travel_diaries'), ['food', 'travel_diaries']);
    assert.deepEqual(candidateWords('The best street food in Pune #food 2024'), ['best', 'street', 'food', 'pune']);
    const merged = mergeTagSuggestions([
        { name: 'related', tags: ['streetfood', 'pune'] },
        { name: 'trending', tags: ['pune', 'cricket', 'food'] },
    ], ['food']);
    assert.equal(merged[0].tag, 'pune');
    assert.equal(merged[0].reason, 'related');
    assert.equal(merged.some((s) => s.tag === 'food'), false);
});

test('#42 city key, discount and trending score', () => {
    assert.equal(cityKey('  Pune,  Maharashtra'), 'pune');
    assert.equal(cityKey(''), '');
    assert.equal(discountOf({ price: 750, originalPrice: 1000 }), 0.25);
    assert.equal(discountOf({ price: 1000, originalPrice: 900 }), 0);
    assert.equal(discountOf({ price: 100 }), 0);
    assert.ok(trendingScore({ likes: 10 }, 1) > trendingScore({ likes: 12 }, 72));
});

test('#10 digest lines and unsubscribe tokens', () => {
    assert.deepEqual(
        digestLines({ like: 3, story_like: 2, comment: 1, follow: 1, mention: 0 }, 4),
        ['5 new likes', '1 new comment', '1 new follower', '4 unread messages'],
    );
    assert.deepEqual(digestLines({}, 0), []);
    const t = unsubscribeToken(OID, 'activity');
    assert.equal(verifyUnsubscribeToken(OID, 'activity', t), true);
    assert.equal(verifyUnsubscribeToken(OID, 'messages', t), false);
    assert.equal(verifyUnsubscribeToken(OID2, 'activity', t), false);
    assert.equal(verifyUnsubscribeToken(OID, 'other', t), false);
});

test('#15 Bin: preview, owned media, restore state', () => {
    const post = { postType: 'photo', contentType: 'product', caption: '', customization: { product: { name: 'Kurta' } }, media: [{ type: 'image', url: 'https://cdn/a.jpg', thumbnailUrl: 'https://cdn/a_t.jpg' }] };
    assert.equal(binPreviewOf('post', post).caption, 'Kurta');
    assert.equal(binPreviewOf('post', post).thumbnailUrl, 'https://cdn/a_t.jpg');
    assert.deepEqual(mediaUrlsOf('post', post), ['https://cdn/a.jpg', 'https://cdn/a_t.jpg']);
    // A repost shows someone else's media: deleting it must never touch that.
    assert.deepEqual(mediaUrlsOf('story', { mediaUrl: 'https://cdn/orig.jpg', sharedPost: { postId: OID } }), []);
    assert.deepEqual(mediaUrlsOf('story', { mediaUrl: 'https://cdn/s.mp4' }), ['https://cdn/s.mp4']);
    const now = new Date('2026-11-03T10:00:00Z');
    assert.deepEqual(restoredStoryState({ expiresAt: new Date('2026-11-03T11:00:00Z') }, now), {});
    assert.deepEqual(restoredStoryState({ expiresAt: new Date('2026-11-02T11:00:00Z') }, now), { isArchived: true });
});
