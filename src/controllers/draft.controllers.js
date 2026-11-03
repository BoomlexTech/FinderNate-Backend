import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Draft from '../models/draft.models.js';
import { uploadPostMedia } from './post/helpers.js';
import { uploadBufferToBunny, generateOptimizedImageUrl, deleteMultipleFromBunny } from '../utils/bunny.js';
import { redisClient } from '../config/redis.config.js';

// Media URLs this server handed to the user from POST /drafts/media. A draft
// may only reference those (or ones it already had), because deleting a
// draft deletes its media from the CDN: accepting any URL would let someone
// delete files that belong to other people.
const issuedKey = (userId) => `fn:draftmedia:${userId}`;
const ISSUED_TTL_SECONDS = 30 * 24 * 60 * 60;

const keepOwnedMedia = async (media, userId, existing = []) => {
    if (!media) return media;
    const already = new Set(existing.map((m) => m.url));
    let issued = new Set();
    try {
        issued = new Set(await redisClient.smembers(issuedKey(userId)));
    } catch { /* only media already on the draft survives */ }
    return media.filter((m) => already.has(m.url) || issued.has(m.url));
};

/**
 * Drafts for posts, vibes and notes (Phase 2 #70).
 *
 * Saving a draft stores the composer's state (`payload`) and uploads its media
 * once (POST /drafts/media). Publishing sends the normal create request with
 * `draftId` and no files: the post takes the draft's media as-is and the draft
 * is removed. Deleting a draft deletes its media.
 */

export const MAX_DRAFTS = 50;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const TYPE_BY_POST_TYPE = { photo: 'Post', reel: 'Reel', video: 'Reel', tweet: 'Tweet' };

/** Validate and shape a draft body. Pure (throws ApiError on bad input). */
export const draftFieldsFrom = (body = {}) => {
    const postType = ['photo', 'reel', 'video', 'tweet'].includes(body.postType) ? body.postType : 'photo';
    const contentType = ['normal', 'product', 'service', 'business'].includes(body.contentType) ? body.contentType : 'normal';
    let payload = body.payload ?? {};
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { throw new ApiError(400, 'payload must be JSON'); }
    }
    if (typeof payload !== 'object' || Array.isArray(payload) || payload === null) {
        throw new ApiError(400, 'payload must be an object');
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
        throw new ApiError(400, 'This draft is too large to save');
    }
    const media = Array.isArray(body.media) ? body.media.slice(0, 10)
        .filter((m) => m && typeof m.url === 'string' && /^https:\/\//.test(m.url))
        .map((m) => ({
            url: m.url,
            thumbnailUrl: typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl : undefined,
            type: m.type === 'video' ? 'video' : 'image',
            width: Number(m.width) || undefined,
            height: Number(m.height) || undefined,
        })) : undefined;
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    return {
        postType,
        contentType,
        type: TYPE_BY_POST_TYPE[postType],
        title,
        payload,
        ...(media ? { media } : {}),
    };
};

const ownDraft = async (draftId, userId) => {
    if (!mongoose.Types.ObjectId.isValid(String(draftId))) throw new ApiError(404, 'Draft not found');
    const draft = await Draft.findOne({ _id: draftId, userId });
    if (!draft) throw new ApiError(404, 'Draft not found');
    return draft;
};

/** GET /drafts?postType= */
export const listDrafts = asyncHandler(async (req, res) => {
    const filter = { userId: req.user._id };
    if (['photo', 'reel', 'video', 'tweet'].includes(req.query.postType)) filter.postType = req.query.postType;
    const drafts = await Draft.find(filter).sort({ updatedAt: -1 }).limit(MAX_DRAFTS)
        .select('postType contentType title media updatedAt createdAt').lean();
    return res.status(200).json(new ApiResponse(200, { drafts }, 'Drafts fetched'));
});

/** GET /drafts/:draftId */
export const getDraft = asyncHandler(async (req, res) => {
    const draft = await ownDraft(req.params.draftId, req.user._id);
    return res.status(200).json(new ApiResponse(200, draft, 'Draft fetched'));
});

/** POST /drafts */
export const createDraft = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    if (await Draft.countDocuments({ userId }) >= MAX_DRAFTS) {
        throw new ApiError(400, `You can keep up to ${MAX_DRAFTS} drafts. Delete one to save another.`);
    }
    const fields = draftFieldsFrom(req.body);
    if (fields.media) fields.media = await keepOwnedMedia(fields.media, userId);
    const draft = await Draft.create({ userId, ...fields, createdAt: new Date(), updatedAt: new Date() });
    return res.status(201).json(new ApiResponse(201, draft, 'Draft saved'));
});

/** PUT /drafts/:draftId — replaces the draft. Media dropped from it is deleted. */
export const updateDraft = asyncHandler(async (req, res) => {
    const draft = await ownDraft(req.params.draftId, req.user._id);
    const fields = draftFieldsFrom(req.body);
    if (fields.media) fields.media = await keepOwnedMedia(fields.media, req.user._id, draft.media || []);
    const before = (draft.media || []).map((m) => m.url);
    Object.assign(draft, fields, { updatedAt: new Date() });
    await draft.save();
    if (fields.media) {
        const kept = new Set(fields.media.map((m) => m.url));
        const dropped = before.filter((url) => !kept.has(url));
        if (dropped.length) deleteMultipleFromBunny(dropped).catch(() => {});
    }
    return res.status(200).json(new ApiResponse(200, draft, 'Draft saved'));
});

/** DELETE /drafts/:draftId */
export const deleteDraft = asyncHandler(async (req, res) => {
    const draft = await ownDraft(req.params.draftId, req.user._id);
    // Only the files themselves: a thumbnail URL is either a variant of the
    // same file or Stream's own still, both removed with it.
    const urls = (draft.media || []).map((m) => m.url).filter(Boolean);
    await draft.deleteOne();
    if (urls.length) deleteMultipleFromBunny(urls).catch(() => {});
    return res.status(200).json(new ApiResponse(200, { draftId: draft._id }, 'Draft deleted'));
});

/**
 * POST /drafts/media (multipart: image / video / reel fields, optional
 * thumbnail). Same limits as a post. Returns the stored media for the draft.
 */
export const uploadDraftMedia = asyncHandler(async (req, res) => {
    const files = [
        ...(req.files?.image || []),
        ...(req.files?.video || []),
        ...(req.files?.reel || []),
        ...(req.files?.media || []),
    ];
    if (!files.length) throw new ApiError(400, 'Attach at least one photo or video');
    const uploaded = await uploadPostMedia(files, req.files?.thumbnail?.[0]);
    const media = uploaded.map((m) => ({
        url: m.url,
        thumbnailUrl: m.thumbnailUrl || undefined,
        type: m.type,
        width: m.dimensions?.width,
        height: m.dimensions?.height,
    }));
    try {
        await redisClient.pipeline()
            .sadd(issuedKey(req.user._id), ...media.map((m) => m.url))
            .expire(issuedKey(req.user._id), ISSUED_TTL_SECONDS)
            .exec();
    } catch { /* the draft save will then keep no media; the client retries */ }
    return res.status(201).json(new ApiResponse(201, { media }, 'Media uploaded'));
});

/**
 * For the create endpoints: the media of the caller's draft, shaped as post
 * media, or null. A new cover (thumbnail file) replaces the video's thumbnail.
 */
export const mediaFromDraft = async (draftId, userId, thumbnailFile = null) => {
    if (!draftId || !mongoose.Types.ObjectId.isValid(String(draftId))) return null;
    const draft = await Draft.findOne({ _id: draftId, userId }).lean();
    if (!draft?.media?.length) return null;
    let coverUrl = null;
    if (thumbnailFile?.buffer) {
        const result = await uploadBufferToBunny(thumbnailFile.buffer, 'posts');
        coverUrl = generateOptimizedImageUrl(result.secure_url, { width: 300, height: 300, crop: 'fill' });
    }
    return draft.media.map((m) => ({
        type: m.type,
        url: m.url,
        thumbnailUrl: m.type === 'video' ? (coverUrl || m.thumbnailUrl || null) : (m.thumbnailUrl || m.url),
        dimensions: { width: m.width, height: m.height },
        processing: false,
    }));
};

/**
 * After a post was published from a draft: drop the draft, and delete any of
 * its media the post didn't take (the user re-attached new files).
 */
export const finishDraft = async (draftId, userId, post) => {
    if (!draftId || !mongoose.Types.ObjectId.isValid(String(draftId))) return;
    const draft = await Draft.findOneAndDelete({ _id: draftId, userId }).lean();
    if (!draft) return;
    const used = new Set((post?.media || []).map((m) => m.url).filter(Boolean));
    const orphaned = (draft.media || []).map((m) => m.url).filter((u) => u && !used.has(u));
    if (orphaned.length) deleteMultipleFromBunny(orphaned).catch(() => {});
};
