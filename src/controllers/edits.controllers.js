import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import MediaEdit from '../models/mediaEdit.models.js';
import Post from '../models/userPost.models.js';
import Story from '../models/story.models.js';
import Block from '../models/block.models.js';
import { User } from '../models/user.models.js';
import { deleteFromBunny } from '../utils/bunny.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import {
    EDIT_LIMITS, FILTER_NAMES, TRANSITION_NAMES, DUET_LAYOUTS, MUSIC_MAX_SECONDS, EditValidationError,
    parseJsonField, sanitizeEdl, planEdit, containerAllowed, isPng, pngSize, fitMusicWindow, duetBlockReason, formatSeconds,
} from '../utils/phase5.rules.js';
import { isFfmpegAvailable, probeMedia } from '../services/ffmpeg.service.js';
import { editsRoot, removeWorkDir } from '../services/mediaRender.service.js';
import { loadUsableSound } from '../services/sounds.service.js';
import { enqueueEdit } from '../queues/creatorQueue.js';

/**
 * The video editor's endpoints (Phase 5 #34, #62, #66, #49, #29).
 *
 *   POST /edits        clips + a JSON edit list  → 202, a render is queued
 *   POST /edits/duet   one recording + the vibe it answers
 *   GET  /edits/:id    progress, then the finished video
 *   DELETE /edits/:id  throw the result away
 *
 * The finished video is attached to a post or story by sending `editId` to
 * the normal create endpoint (see mediaFromEdit below).
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

// ── Upload handling: to disk, never to memory ───────────────────────────────

const incomingDir = () => path.join(editsRoot(), 'incoming');

const editUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            try { fs.mkdirSync(incomingDir(), { recursive: true }); cb(null, incomingDir()); } catch (e) { cb(e); }
        },
        filename: (req, file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: EDIT_LIMITS.maxClipMb * 1024 * 1024, files: EDIT_LIMITS.maxClips + EDIT_LIMITS.maxOverlays },
    fileFilter: (req, file, cb) => {
        const ok = (file.fieldname === 'clips' && file.mimetype?.startsWith('video/')) ||
            (file.fieldname === 'overlays' && file.mimetype === 'image/png');
        if (ok) return cb(null, true);
        return cb(Object.assign(new Error(file.fieldname === 'overlays'
            ? 'Text, stickers and price tags have to be PNG images.'
            : 'Only video clips can be edited.'), { status: 400 }), false);
    },
}).fields([{ name: 'clips', maxCount: EDIT_LIMITS.maxClips }, { name: 'overlays', maxCount: EDIT_LIMITS.maxOverlays }]);

export const receiveEditFiles = (req, res, next) => editUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, `Each clip can be up to ${EDIT_LIMITS.maxClipMb} MB.`));
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(new ApiError(400, `You can combine up to ${EDIT_LIMITS.maxClips} clips and ${EDIT_LIMITS.maxOverlays} layers.`));
    return next(new ApiError(err.status || 400, err.message || 'Could not read the upload.'));
});

const allUploaded = (req) => [...(req.files?.clips || []), ...(req.files?.overlays || [])];
const discardUploads = (req) => Promise.all(allUploaded(req).map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));

// ── Views ───────────────────────────────────────────────────────────────────

const editView = (e) => ({
    _id: e._id,
    kind: e.kind,
    status: e.status,
    progress: e.progress || 0,
    error: e.status === 'failed' ? (e.error || 'Something went wrong.') : undefined,
    result: e.status === 'done' && e.result ? {
        type: 'video',
        url: e.result.url,
        thumbnailUrl: e.result.thumbnailUrl,
        coverUrl: e.result.coverUrl,
        duration: e.result.duration,
        width: e.result.width,
        height: e.result.height,
        processing: e.result.processing === true,
    } : undefined,
    duet: e.duet ? { postId: e.duet.postId, authorUsername: e.duet.authorUsername, layout: e.duet.layout } : undefined,
    music: e.music,
    createdAt: e.createdAt,
});

// ── Config ──────────────────────────────────────────────────────────────────

/** GET /edits/config — what the editor can offer, and whether it is switched on. */
export const getEditConfig = asyncHandler(async (req, res) => {
    const [ffmpeg, enabled, maxSeconds] = await Promise.all([
        isFfmpegAvailable(),
        getSettingValue('CREATOR_EDITS_ENABLED', true),
        getSettingValue('EDIT_MAX_OUTPUT_SECONDS', EDIT_LIMITS.maxOutputSeconds),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        available: ffmpeg && enabled !== false && enabled !== 'false',
        maxClips: EDIT_LIMITS.maxClips,
        maxLayers: EDIT_LIMITS.maxOverlays,
        maxClipMb: EDIT_LIMITS.maxClipMb,
        maxSeconds: Math.min(Number(maxSeconds) || EDIT_LIMITS.maxOutputSeconds, EDIT_LIMITS.maxOutputSeconds),
        speed: { min: EDIT_LIMITS.minSpeed, max: EDIT_LIMITS.maxSpeed },
        output: { width: EDIT_LIMITS.width, height: EDIT_LIMITS.height },
        filters: FILTER_NAMES,
        transitions: TRANSITION_NAMES,
        duetLayouts: DUET_LAYOUTS,
        music: { maxSecondsPost: MUSIC_MAX_SECONDS.post, maxSecondsStory: MUSIC_MAX_SECONDS.story },
    }, 'Editor settings'));
});

// ── Creating an edit ────────────────────────────────────────────────────────

const assertEditorOn = async () => {
    const enabled = await getSettingValue('CREATOR_EDITS_ENABLED', true);
    if (enabled === false || enabled === 'false' || !(await isFfmpegAvailable())) {
        throw new ApiError(503, 'Video editing is not available right now. Please try again later.');
    }
};

const assertWithinLimits = async (userId) => {
    const [maxActive, perDay] = await Promise.all([
        getSettingValue('EDIT_MAX_ACTIVE_PER_USER', 2),
        getSettingValue('EDIT_DAILY_LIMIT', 30),
    ]);
    const [active, today] = await Promise.all([
        MediaEdit.countDocuments({ userId, status: { $in: ['queued', 'processing'] } }),
        MediaEdit.countDocuments({ userId, createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
    ]);
    if (active >= Number(maxActive)) throw new ApiError(429, 'Your other videos are still being prepared. Wait for them to finish.');
    if (today >= Number(perDay)) throw new ApiError(429, "You've reached today's limit for editing videos. Try again tomorrow.");
};

/** The overlay PNGs are checked by what they are, not by what the client called them. */
const checkOverlays = async (files) => {
    for (const f of files) {
        if (f.size > EDIT_LIMITS.maxOverlayKb * 1024) throw new EditValidationError(`Each text or sticker layer can be up to ${EDIT_LIMITS.maxOverlayKb / 1024} MB.`);
        const fd = await fsp.open(f.path, 'r');
        try {
            const head = Buffer.alloc(32);
            await fd.read(head, 0, 32, 0);
            const size = pngSize(head);
            if (!isPng(head) || !size) throw new EditValidationError('Text, stickers and price tags have to be PNG images.');
            if (size.width * size.height > EDIT_LIMITS.maxOverlayPixels) throw new EditValidationError('One of your layers is too large.');
        } finally {
            await fd.close();
        }
    }
};

const probeClips = async (files) => {
    const probes = [];
    for (const [i, f] of files.entries()) {
        let info;
        try { info = await probeMedia(f.path); } catch { throw new EditValidationError(`Clip ${i + 1} could not be read as a video.`); }
        if (!info.hasVideo || !containerAllowed(info.format, 'video')) throw new EditValidationError(`Clip ${i + 1} could not be read as a video.`);
        if (!(info.durationSec > 0)) throw new EditValidationError(`Clip ${i + 1} has no length.`);
        probes.push(info);
    }
    return probes;
};

/** Moves the uploads out of the shared incoming folder into this edit's own folder. */
const adoptFiles = async (req, editId) => {
    const dir = path.join(editsRoot(), String(editId));
    await fsp.mkdir(dir, { recursive: true });
    const clips = [];
    const overlays = [];
    for (const [i, f] of (req.files?.clips || []).entries()) {
        const dest = path.join(dir, `clip${i}`);
        await fsp.rename(f.path, dest);
        clips.push(dest);
    }
    for (const [i, f] of (req.files?.overlays || []).entries()) {
        const dest = path.join(dir, `layer${i}.png`);
        await fsp.rename(f.path, dest);
        overlays.push(dest);
    }
    return { dir, clips, overlays };
};

const startEdit = async (req, res, kind) => {
    const userId = req.user._id;
    try {
        await assertEditorOn();
        await assertWithinLimits(userId);

        const raw = parseJsonField(req.body?.edl, null) ?? {};
        const maxSeconds = Number(await getSettingValue('EDIT_MAX_OUTPUT_SECONDS', EDIT_LIMITS.maxOutputSeconds)) || EDIT_LIMITS.maxOutputSeconds;
        const clipFiles = req.files?.clips || [];
        const overlayFiles = req.files?.overlays || [];

        let edl;
        try {
            edl = sanitizeEdl(raw, { clipCount: clipFiles.length, overlayCount: overlayFiles.length, kind, maxOutputSeconds: maxSeconds });
        } catch (e) {
            throw e instanceof EditValidationError ? new ApiError(400, e.message) : e;
        }

        await checkOverlays(overlayFiles);
        const probes = { clips: await probeClips(clipFiles) };

        // Music: the server looks the song up and fits the window to the track.
        let musicMeta;
        if (edl.music) {
            const sound = await loadUsableSound(edl.music.soundId, userId);
            edl.music = fitMusicWindow({ ...edl.music, soundId: String(sound._id) }, sound.durationSec);
            musicMeta = { soundId: sound._id, startSec: edl.music.startSec, durationSec: edl.music.durationSec, volume: edl.music.volume };
        }

        let duet;
        if (kind === 'duet') {
            const originalId = req.body?.originalPostId || raw.originalPostId || raw.duet?.originalPostId;
            if (!isValidId(originalId)) throw new ApiError(400, 'Choose the video to make a duet with.');
            const post = await Post.findById(originalId).select('userId postType status media settings').lean();
            const [owner, blocked] = await Promise.all([
                post ? User.findById(post.userId).select('username privacy isFullPrivate isDeleted accountStatus').lean() : null,
                post ? Block.exists({ $or: [{ blockerId: userId, blockedId: post.userId }, { blockerId: post.userId, blockedId: userId }] }) : null,
            ]);
            const ownerPrivate = owner?.privacy === 'private' || owner?.isFullPrivate === true;
            const reason = duetBlockReason({ post, ownerPrivate, blocked: !!blocked, viewerId: userId })
                || (owner?.isDeleted || ['deactivated', 'banned'].includes(owner?.accountStatus) ? 'That video is not available.' : null);
            if (reason) throw new ApiError(403, reason);
            duet = { postId: post._id, authorId: post.userId, authorUsername: owner.username, layout: edl.duet.layout };
        } else {
            // Check the timeline now so a too-long video is refused before it is queued.
            try { planEdit(edl, probes); } catch (e) { throw e instanceof EditValidationError ? new ApiError(400, e.message) : e; }
        }
        if (kind === 'duet') {
            const mineSeconds = probes.clips[0].durationSec;
            if (mineSeconds < EDIT_LIMITS.minClipSeconds) throw new ApiError(400, 'That clip is too short to use.');
            if (mineSeconds > maxSeconds + 1) throw new ApiError(400, `Your video can be up to ${formatSeconds(maxSeconds)}. This one is ${formatSeconds(mineSeconds)}.`);
        }

        const edit = new MediaEdit({ userId, kind, status: 'queued', edl, probes, duet, music: musicMeta });
        const adopted = await adoptFiles(req, edit._id);
        edit.workDir = adopted.dir;
        edit.files = { clips: adopted.clips, overlays: adopted.overlays };
        await edit.save();

        try {
            await enqueueEdit(edit._id);
        } catch (e) {
            await MediaEdit.updateOne({ _id: edit._id }, { $set: { status: 'failed', error: 'Video editing is busy right now. Please try again.' } });
            await removeWorkDir(adopted.dir);
            throw new ApiError(503, 'Video editing is busy right now. Please try again in a moment.');
        }
        return res.status(202).json(new ApiResponse(202, editView(edit.toObject()), 'Your video is being prepared'));
    } catch (err) {
        await discardUploads(req);
        throw err;
    }
};

/** POST /edits (multipart: clips[], overlays[], edl JSON) */
export const createEdit = asyncHandler((req, res) => startEdit(req, res, 'reel'));

/** POST /edits/duet (multipart: clips[1], overlays[], edl JSON, originalPostId) */
export const createDuetEdit = asyncHandler((req, res) => startEdit(req, res, 'duet'));

/** GET /edits/:id */
export const getEdit = asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) throw new ApiError(404, 'We could not find that video.');
    const edit = await MediaEdit.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!edit) throw new ApiError(404, 'We could not find that video.');
    return res.status(200).json(new ApiResponse(200, editView(edit), 'Edit'));
});

/** Deletes the files an edit produced, unless a post or story is using them. */
export const releaseEditResult = async (edit) => {
    const urls = [edit.result?.url, edit.result?.coverUrl].filter(Boolean);
    if (!urls.length) return;
    const inUse = await Promise.all([
        Post.exists({ 'media.url': edit.result.url }),
        Story.exists({ mediaUrl: edit.result.url }),
    ]);
    if (inUse.some(Boolean)) return;
    for (const url of urls) { try { await deleteFromBunny(url); } catch { /* the cleanup job tries again */ } }
};

/** DELETE /edits/:id — give up on an edit; frees the result if nothing uses it. */
export const discardEdit = asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) throw new ApiError(404, 'We could not find that video.');
    const edit = await MediaEdit.findOne({ _id: req.params.id, userId: req.user._id });
    if (!edit) throw new ApiError(404, 'We could not find that video.');
    if (edit.status === 'processing') throw new ApiError(409, 'Your video is being prepared. Try again once it finishes.');
    if (edit.usedAt) throw new ApiError(409, 'That video is already part of a post.');
    if (edit.status === 'done') await releaseEditResult(edit.toObject());
    await removeWorkDir(edit.workDir);
    edit.status = 'expired';
    edit.cleanedAt = new Date();
    await edit.save();
    return res.status(200).json(new ApiResponse(200, { _id: edit._id }, 'Discarded'));
});

// ── Used by the post and story create paths ─────────────────────────────────

/**
 * The finished edit behind `editId`, for a post or story that is being
 * created now. Returns null when no editId was sent; throws an error a person
 * can act on when the edit is not ready or not theirs.
 */
export const loadFinishedEdit = async (editId, userId) => {
    if (editId === undefined || editId === null || editId === '') return null;
    if (!isValidId(editId)) throw new ApiError(404, 'We could not find that edited video. Edit it again.');
    const edit = await MediaEdit.findOne({ _id: editId, userId }).lean();
    if (!edit) throw new ApiError(404, 'We could not find that edited video. Edit it again.');
    if (edit.status === 'queued' || edit.status === 'processing') throw new ApiError(409, 'Your video is still being prepared. Try again in a moment.');
    if (edit.status !== 'done' || !edit.result?.url) throw new ApiError(410, edit.error || 'That video was not finished. Edit it again.');
    return edit;
};

/** The media entry for a finished edit, in the shape a post stores. */
export const mediaFromEdit = async (editId, userId) => {
    const edit = await loadFinishedEdit(editId, userId);
    if (!edit) return null;
    const r = edit.result;
    return [{
        type: 'video',
        url: r.url,
        thumbnailUrl: r.thumbnailUrl || null,
        duration: r.duration || null,
        dimensions: { width: r.width, height: r.height },
        fileSize: r.fileSize,
        format: r.format || 'mp4',
        processing: r.processing === true,
    }];
};

/** Remember which post or story took the video, so the cleanup job leaves it alone. */
export const markEditUsed = (editId, { postId, storyId } = {}) => {
    if (!editId || !isValidId(editId)) return Promise.resolve();
    const set = { usedAt: new Date() };
    if (postId) set.usedByPostId = postId;
    if (storyId) set.usedByStoryId = storyId;
    return MediaEdit.updateOne({ _id: editId }, { $set: set }).catch(() => {});
};
