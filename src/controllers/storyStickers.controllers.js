import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Story from '../models/story.models.js';
import StickerResponse from '../models/stickerResponse.models.js';
import { User } from '../models/user.models.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { assertCanEngage } from './storyEngagement.controllers.js';
import {
    EditValidationError, readStickerAnswer, summarizeSticker, statsFromGroups, stickersForViewer, MAX_QUESTION_ANSWER_LENGTH,
} from '../utils/phase5.rules.js';

/**
 * Interactive story stickers (Phase 5 #47): answering them, and the owner's
 * view of the answers. The stickers themselves are saved with the story (see
 * uploadStory); answers live in StickerResponse.
 *
 *   POST /stories/:storyId/stickers/:stickerId/respond
 *   GET  /stories/:storyId/stickers/results                      (owner)
 *   POST /stories/:storyId/stickers/:stickerId/questions/:responseId/reply   (owner)
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

const loadStoryWithStickers = async (storyId) => {
    if (!isValidId(storyId)) throw new ApiError(404, 'Story not found');
    const story = await Story.findById(storyId).select('userId isArchived expiresAt stickers').lean();
    if (!story) throw new ApiError(404, 'Story not found');
    return story;
};

const aggregateStats = async (storyIds) => {
    if (!storyIds.length) return new Map();
    const groups = await StickerResponse.aggregate([
        { $match: { storyId: { $in: storyIds } } },
        {
            $group: {
                _id: { s: '$storyId', k: '$stickerId', c: '$choice' },
                n: { $sum: 1 },
                correct: { $sum: { $cond: [{ $eq: ['$isCorrect', true] }, 1, 0] } },
                valueSum: { $sum: { $ifNull: ['$value', 0] } },
                reminders: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$remindAt', null] }, null] }, 1, 0] } },
            },
        },
    ]);
    const byKey = new Map();
    for (const g of groups) {
        const key = `${g._id.s}:${g._id.k}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ choice: g._id.c ?? null, n: g.n, correct: g.correct, valueSum: g.valueSum, reminders: g.reminders });
    }
    return byKey;
};

/**
 * Adds what each viewer needs to render the stickers on stories they are about
 * to open: `stickers` (without the quiz answer for other people) and
 * `stickerState`, one summary per sticker. Mutates and returns the list.
 * Stories without stickers cost nothing; the rest cost two queries in total.
 */
export const attachStickerState = async (storyObjs, viewerId) => {
    const withStickers = storyObjs.filter((o) => o?.stickers?.length && isValidId(o._id));
    if (!withStickers.length) return storyObjs;
    const ids = withStickers.map((o) => new mongoose.Types.ObjectId(String(o._id)));
    const [stats, mine] = await Promise.all([
        aggregateStats(ids),
        viewerId ? StickerResponse.find({ storyId: { $in: ids }, userId: viewerId }).lean() : [],
    ]);
    const mineByKey = new Map(mine.map((r) => [`${r.storyId}:${r.stickerId}`, r]));
    for (const o of withStickers) {
        const isOwner = !!viewerId && String(o.userId?._id ?? o.userId) === String(viewerId);
        o.stickerState = o.stickers.map((st) => {
            const key = `${o._id}:${st.id}`;
            return summarizeSticker(st, statsFromGroups(st, stats.get(key) || []), mineByKey.get(key), isOwner);
        });
        o.stickers = stickersForViewer(o.stickers, isOwner);
    }
    return storyObjs;
};

const preview = (text, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** POST /stories/:storyId/stickers/:stickerId/respond */
export const respondToSticker = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const story = await loadStoryWithStickers(req.params.storyId);
    const sticker = (story.stickers || []).find((s) => s.id === req.params.stickerId);
    if (!sticker) throw new ApiError(404, 'That sticker is not on this story.');
    if (String(story.userId) === String(userId)) throw new ApiError(403, "You can't answer your own sticker.");
    await assertCanEngage(story, userId);

    let answer;
    try { answer = readStickerAnswer(sticker, req.body); } catch (e) {
        throw e instanceof EditValidationError ? new ApiError(400, e.message) : e;
    }

    const filter = { storyId: story._id, stickerId: sticker.id, userId };
    const base = { storyOwnerId: story.userId, stickerType: sticker.type };
    let mine;

    if (sticker.type === 'countdown') {
        const endsAt = new Date(sticker.data?.endsAt);
        const remindAt = answer.remind && endsAt.getTime() > Date.now() ? endsAt : null;
        mine = await StickerResponse.findOneAndUpdate(
            filter,
            { $set: { ...base, remindAt, remindNotifiedAt: null, countdownTitle: sticker.data?.title || 'Countdown' }, $setOnInsert: filter },
            { upsert: true, new: true }
        ).lean();
    } else {
        const existing = await StickerResponse.findOne(filter).lean();
        if (existing) {
            // First answer stands: a poll vote cannot be changed, and a question is asked once.
            const stats = statsFromGroups(sticker, (await aggregateStats([story._id])).get(`${story._id}:${sticker.id}`) || []);
            return res.status(409).json(new ApiResponse(409, summarizeSticker(sticker, stats, existing, false), 'You already answered this'));
        }
        try {
            mine = (await StickerResponse.create({ ...filter, ...base, ...answer })).toObject();
        } catch (e) {
            if (e?.code === 11000) throw new ApiError(409, 'You already answered this');
            throw e;
        }
        if (sticker.type === 'question') {
            notifyActivity({
                recipientId: story.userId,
                senderId: userId,
                type: 'story_question',
                message: `asked you a question: “${preview(answer.text)}”`,
                storyId: story._id,
                data: { stickerId: sticker.id },
                push: { title: 'New question', url: '/notifications' },
            }).catch(() => {});
        }
    }

    const stats = statsFromGroups(sticker, (await aggregateStats([story._id])).get(`${story._id}:${sticker.id}`) || []);
    return res.status(200).json(new ApiResponse(200, summarizeSticker(sticker, stats, mine, false), 'Thanks'));
});

const userCard = (u) => (u ? { _id: u._id, username: u.username, fullName: u.fullName, profileImageUrl: u.profileImageUrl } : null);

/** GET /stories/:storyId/stickers/results — owner only; works on archived stories too. */
export const getStickerResults = asyncHandler(async (req, res) => {
    const story = await loadStoryWithStickers(req.params.storyId);
    if (String(story.userId) !== String(req.user._id)) throw new ApiError(403, 'Only the person who posted this story can see that');
    const stats = await aggregateStats([story._id]);

    const stickers = [];
    for (const sticker of story.stickers || []) {
        const summary = summarizeSticker(sticker, statsFromGroups(sticker, stats.get(`${story._id}:${sticker.id}`) || []), null, true);
        const entry = { ...summary, data: sticker.data };
        if (sticker.type !== 'countdown') {
            const rows = await StickerResponse.find({ storyId: story._id, stickerId: sticker.id }).sort({ createdAt: -1 }).limit(200).lean();
            const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('username fullName profileImageUrl').lean();
            const byId = new Map(users.map((u) => [String(u._id), u]));
            if (sticker.type === 'question') {
                entry.questions = rows.map((r) => ({ _id: r._id, user: userCard(byId.get(String(r.userId))), text: r.text, createdAt: r.createdAt, reply: r.reply || undefined }));
            } else {
                entry.responders = rows.map((r) => ({ user: userCard(byId.get(String(r.userId))), choice: r.choice, value: r.value, isCorrect: r.isCorrect, createdAt: r.createdAt }));
            }
        }
        stickers.push(entry);
    }
    return res.status(200).json(new ApiResponse(200, { storyId: story._id, stickers }, 'Sticker results'));
});

/** POST /stories/:storyId/stickers/:stickerId/questions/:responseId/reply { text } */
export const replyToQuestion = asyncHandler(async (req, res) => {
    const story = await loadStoryWithStickers(req.params.storyId);
    if (String(story.userId) !== String(req.user._id)) throw new ApiError(403, 'Only the person who posted this story can answer');
    if (!isValidId(req.params.responseId)) throw new ApiError(404, 'That question is not here.');
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_ANSWER_LENGTH) : '';
    if (!text) throw new ApiError(400, 'Write your answer first.');
    const row = await StickerResponse.findOneAndUpdate(
        { _id: req.params.responseId, storyId: story._id, stickerId: req.params.stickerId, stickerType: 'question' },
        { $set: { reply: { text, at: new Date() } } },
        { new: true }
    ).lean();
    if (!row) throw new ApiError(404, 'That question is not here.');
    notifyActivity({
        recipientId: row.userId,
        senderId: req.user._id,
        type: 'story_question_reply',
        message: `answered your question: “${preview(text)}”`,
        storyId: story._id,
        data: { stickerId: row.stickerId },
        push: { title: 'Your question was answered', url: '/notifications' },
    }).catch(() => {});
    return res.status(200).json(new ApiResponse(200, { _id: row._id, reply: row.reply }, 'Answer sent'));
});

/** Countdown reminders that have come due (run every few minutes by the Phase 5 job). */
export const runCountdownReminders = async () => {
    const now = new Date();
    const due = await StickerResponse.find({ remindAt: { $lte: now }, remindNotifiedAt: null, stickerType: 'countdown' }).limit(500).lean();
    if (!due.length) return { sent: 0 };
    await StickerResponse.updateMany({ _id: { $in: due.map((d) => d._id) } }, { $set: { remindNotifiedAt: now } });
    await Promise.allSettled(due.map((r) => notifyActivity({
        recipientId: r.userId,
        senderId: r.storyOwnerId,
        type: 'story_countdown',
        message: `“${r.countdownTitle || 'Countdown'}” has started`,
        data: { title: r.countdownTitle || 'Countdown' },
        push: { title: 'Countdown', url: '/notifications' },
    })));
    return { sent: due.length };
};

/** Delete the answers of a story that is gone for good, keeping reminders still waiting to fire. */
export const clearStickerResponses = (storyId) =>
    StickerResponse.deleteMany({ storyId, $or: [{ remindAt: null }, { remindNotifiedAt: { $ne: null } }, { stickerType: { $ne: 'countdown' } }] }).catch(() => {});
