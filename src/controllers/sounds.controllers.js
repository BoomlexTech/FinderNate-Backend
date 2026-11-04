import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Sound from '../models/sound.models.js';
import SavedSound from '../models/savedSound.models.js';
import Post from '../models/userPost.models.js';
import Story from '../models/story.models.js';
import { User } from '../models/user.models.js';
import { uploadBufferToBunny, deleteFromBunny } from '../utils/bunny.js';
import { soundCard } from '../services/sounds.service.js';
import { editsRoot, removeWorkDir } from '../services/mediaRender.service.js';
import { probeMedia } from '../services/ffmpeg.service.js';
import { containerAllowed } from '../utils/phase5.rules.js';
import { loadCards } from './trending.controllers.js';

/**
 * Sounds (Phase 5 #29): browse and search, save for later, the page of a
 * sound, and the admin screens that stock the royalty-free library.
 */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const savedSet = async (userId, ids) => {
    if (!userId || !ids.length) return new Set();
    const rows = await SavedSound.find({ userId, soundId: { $in: ids } }).select('soundId').lean();
    return new Set(rows.map((r) => String(r.soundId)));
};

/**
 * GET /sounds?q&source=library|original&genre&mood&language&sort=trending|new&page&limit
 * The library by default; a search looks through original audio too.
 */
export const listSounds = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const q = clean(req.query.q, 60);
    const match = { status: 'active' };
    if (['library', 'original'].includes(req.query.source)) match.source = req.query.source;
    else if (!q) match.source = 'library';
    if (match.source !== 'library') match.allowReuse = { $ne: false };
    for (const key of ['genre', 'mood', 'language']) {
        const v = clean(req.query[key], 40).toLowerCase();
        if (v) match[key] = v;
    }
    if (q) {
        const rx = new RegExp(escapeRegex(q), 'i');
        match.$or = [{ title: rx }, { artist: rx }];
    }
    const sort = req.query.sort === 'new'
        ? { createdAt: -1, _id: -1 }
        : { usageCount: -1, lastUsedAt: -1, _id: -1 };

    const rows = await Sound.find(match).sort(sort).skip((page - 1) * limit).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const saved = await savedSet(req.user?._id, items.map((s) => s._id));

    const payload = { sounds: items.map((s) => soundCard(s, { saved: saved.has(String(s._id)) })), pagination: { page, limit, hasMore } };
    if (page === 1) {
        const genres = await Sound.distinct('genre', { source: 'library', status: 'active' });
        payload.genres = genres.filter(Boolean).sort();
    }
    return res.status(200).json(new ApiResponse(200, payload, 'Sounds'));
});

/** GET /sounds/saved */
export const mySavedSounds = asyncHandler(async (req, res) => {
    const rows = await SavedSound.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const sounds = await Sound.find({ _id: { $in: rows.map((r) => r.soundId) }, status: 'active' }).lean();
    const byId = new Map(sounds.map((s) => [String(s._id), s]));
    const ordered = rows.map((r) => byId.get(String(r.soundId))).filter(Boolean);
    return res.status(200).json(new ApiResponse(200, { sounds: ordered.map((s) => soundCard(s, { saved: true })) }, 'Saved sounds'));
});

const loadActive = async (id) => {
    if (!isValidId(id)) throw new ApiError(404, 'That sound is not available.');
    const sound = await Sound.findOne({ _id: id, status: 'active' }).lean();
    if (!sound) throw new ApiError(404, 'That sound is not available.');
    return sound;
};

/** GET /sounds/:id */
export const getSound = asyncHandler(async (req, res) => {
    const sound = await loadActive(req.params.id);
    const [saved, postsCount, owner] = await Promise.all([
        savedSet(req.user?._id, [sound._id]),
        Post.countDocuments({ 'music.soundId': sound._id, 'settings.privacy': { $ne: 'private' }, status: { $in: ['published', null] } }),
        sound.ownerId ? User.findById(sound.ownerId).select('username fullName profileImageUrl').lean() : null,
    ]);
    return res.status(200).json(new ApiResponse(200, {
        ...soundCard(sound, { saved: saved.has(String(sound._id)) }),
        postsCount,
        owner: owner || undefined,
        canReuse: sound.allowReuse !== false || String(sound.ownerId) === String(req.user?._id),
    }, 'Sound'));
});

/** GET /sounds/:id/posts?page&limit — public posts that use this sound. */
export const getSoundPosts = asyncHandler(async (req, res) => {
    const sound = await loadActive(req.params.id);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 18));
    const rows = await Post.find({
        'music.soundId': sound._id, 'settings.privacy': { $ne: 'private' }, status: { $in: ['published', null] },
    }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit * 2).select('_id').lean();
    const posts = await loadCards(rows.map((r) => String(r._id)), req, limit);
    return res.status(200).json(new ApiResponse(200, { posts, pagination: { page, limit, hasMore: rows.length >= limit } }, 'Posts with this sound'));
});

/** POST /sounds/:id/save, DELETE /sounds/:id/save */
export const saveSound = asyncHandler(async (req, res) => {
    const sound = await loadActive(req.params.id);
    await SavedSound.updateOne({ userId: req.user._id, soundId: sound._id }, { $setOnInsert: { userId: req.user._id, soundId: sound._id } }, { upsert: true });
    return res.status(200).json(new ApiResponse(200, { soundId: sound._id, isSaved: true }, 'Saved'));
});

export const unsaveSound = asyncHandler(async (req, res) => {
    if (isValidId(req.params.id)) await SavedSound.deleteOne({ userId: req.user._id, soundId: req.params.id });
    return res.status(200).json(new ApiResponse(200, { soundId: req.params.id, isSaved: false }, 'Removed'));
});

/** PATCH /sounds/:id { allowReuse } — the creator turns "Use this audio" on or off. */
export const updateMySound = asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) throw new ApiError(404, 'That sound is not available.');
    if (typeof req.body?.allowReuse !== 'boolean') throw new ApiError(400, 'Send allowReuse as true or false.');
    const sound = await Sound.findOneAndUpdate(
        { _id: req.params.id, source: 'original', ownerId: req.user._id },
        { $set: { allowReuse: req.body.allowReuse } },
        { new: true }
    ).lean();
    if (!sound) throw new ApiError(404, 'That sound is not available.');
    return res.status(200).json(new ApiResponse(200, soundCard(sound), req.body.allowReuse ? 'Others can use this audio' : 'Others can no longer use this audio'));
});

// ── Admin: the royalty-free library ─────────────────────────────────────────

export const adminSoundUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 2 },
}).fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

const LICENCE_TYPES = ['royalty_free', 'cc0', 'cc_by', 'licensed'];
const MAX_TRACK_SECONDS = 10 * 60;

const withTempFile = async (buffer, ext, fn) => {
    const dir = path.join(editsRoot(), `upload-${crypto.randomBytes(6).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });
    try {
        const file = path.join(dir, `track${ext}`);
        await fsp.writeFile(file, buffer);
        return await fn(file);
    } finally {
        await removeWorkDir(dir);
    }
};

/** GET /admin/sounds?status&source&q&page */
export const adminListSounds = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const match = {};
    if (['active', 'hidden', 'removed'].includes(req.query.status)) match.status = req.query.status;
    if (['library', 'original'].includes(req.query.source)) match.source = req.query.source;
    const q = clean(req.query.q, 60);
    if (q) { const rx = new RegExp(escapeRegex(q), 'i'); match.$or = [{ title: rx }, { artist: rx }]; }
    const [rows, total] = await Promise.all([
        Sound.find(match).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Sound.countDocuments(match),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        sounds: rows.map((s) => ({ ...soundCard(s), status: s.status, licence: s.licence, createdAt: s.createdAt })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Sounds'));
});

/** POST /admin/sounds (multipart: audio, cover?; fields title, artist, genre, mood, language, licenceType, provider, attribution, licenceUrl) */
export const adminCreateSound = asyncHandler(async (req, res) => {
    const audio = req.files?.audio?.[0];
    const cover = req.files?.cover?.[0];
    if (!audio) throw new ApiError(400, 'Choose an audio file.');
    if (!audio.mimetype?.startsWith('audio/')) throw new ApiError(400, 'That file is not audio.');
    const title = clean(req.body.title, 120);
    if (!title) throw new ApiError(400, 'Give the track a title.');
    const licenceType = LICENCE_TYPES.includes(req.body.licenceType) ? req.body.licenceType : 'royalty_free';

    const ext = path.extname(audio.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.mp3';
    const info = await withTempFile(audio.buffer, ext, probeMedia).catch(() => null);
    if (!info || !info.hasAudio || !containerAllowed(info.format, 'audio')) throw new ApiError(400, 'That audio file could not be read. Try an MP3 or M4A.');
    if (!(info.durationSec >= 3)) throw new ApiError(400, 'That track is too short.');
    if (info.durationSec > MAX_TRACK_SECONDS) throw new ApiError(400, 'Tracks can be up to 10 minutes long.');

    const uploaded = await uploadBufferToBunny(audio.buffer, 'sounds', `track${ext}`, audio.mimetype);
    if (!uploaded?.secure_url) throw new ApiError(500, 'Could not store the track.');
    let coverUrl = '';
    if (cover?.buffer && cover.mimetype?.startsWith('image/')) {
        try { coverUrl = (await uploadBufferToBunny(cover.buffer, 'sounds'))?.secure_url || ''; } catch { /* the track is still usable without art */ }
    }

    const sound = await Sound.create({
        source: 'library',
        title,
        artist: clean(req.body.artist, 120),
        audioUrl: uploaded.secure_url,
        coverUrl,
        durationSec: Math.round(info.durationSec * 10) / 10,
        genre: clean(req.body.genre, 40).toLowerCase(),
        mood: clean(req.body.mood, 40).toLowerCase(),
        language: clean(req.body.language, 20).toLowerCase(),
        licence: {
            type: licenceType,
            provider: clean(req.body.provider, 120),
            attribution: clean(req.body.attribution, 300),
            url: clean(req.body.licenceUrl, 300),
        },
        createdBy: req.admin?._id,
    });
    return res.status(201).json(new ApiResponse(201, soundCard(sound.toObject()), 'Track added to the library'));
});

/** PATCH /admin/sounds/:id { title, artist, genre, mood, language, status: active|hidden } */
export const adminUpdateSound = asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) throw new ApiError(404, 'Sound not found');
    const set = {};
    for (const [key, max] of [['title', 120], ['artist', 120], ['genre', 40], ['mood', 40], ['language', 20]]) {
        if (typeof req.body[key] === 'string') set[key] = ['genre', 'mood', 'language'].includes(key) ? clean(req.body[key], max).toLowerCase() : clean(req.body[key], max);
    }
    if (set.title === '') throw new ApiError(400, 'The title cannot be empty.');
    if (['active', 'hidden'].includes(req.body.status)) set.status = req.body.status;
    if (typeof req.body.allowReuse === 'boolean') set.allowReuse = req.body.allowReuse;
    if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to change.');
    const sound = await Sound.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!sound) throw new ApiError(404, 'Sound not found');
    return res.status(200).json(new ApiResponse(200, { ...soundCard(sound), status: sound.status }, 'Updated'));
});

/**
 * DELETE /admin/sounds/:id — only when nothing uses it. A track that is under
 * posts or stories is hidden instead (PATCH status=hidden): it can no longer be
 * picked, and the posts keep playing.
 */
export const adminDeleteSound = asyncHandler(async (req, res) => {
    if (!isValidId(req.params.id)) throw new ApiError(404, 'Sound not found');
    const sound = await Sound.findById(req.params.id).lean();
    if (!sound) throw new ApiError(404, 'Sound not found');
    const [posts, stories] = await Promise.all([
        Post.countDocuments({ 'music.soundId': sound._id }),
        Story.countDocuments({ 'music.soundId': sound._id }),
    ]);
    if (posts + stories > 0) {
        throw new ApiError(409, `This track is used by ${posts + stories} post${posts + stories === 1 ? '' : 's'} or stories. Hide it instead so it cannot be picked again.`);
    }
    try { await deleteFromBunny(sound.audioUrl); if (sound.coverUrl && sound.source === 'library') await deleteFromBunny(sound.coverUrl); } catch (e) {
        throw new ApiError(502, `Could not remove the file: ${e.message}`);
    }
    await Promise.all([Sound.deleteOne({ _id: sound._id }), SavedSound.deleteMany({ soundId: sound._id })]);
    return res.status(200).json(new ApiResponse(200, { _id: sound._id }, 'Deleted'));
});
