import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Sound from '../models/sound.models.js';
import SavedSound from '../models/savedSound.models.js';
import Story from '../models/story.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { uploadBufferToBunny, deleteFromBunny } from '../utils/bunny.js';
import * as ffmpegSvc from './ffmpeg.service.js';
import { editsRoot, downloadToFile, downloadFirst, renditionFallbacks, removeWorkDir } from './mediaRender.service.js';
import { buildAudioExtractArgs, hasUsableSound } from '../utils/phase5.rules.js';

/**
 * Sounds for posts, vibes and stories (Phase 5 #29): picking one, labelling a
 * post with it, and turning a vibe's own audio into a sound others can reuse.
 */

/** The shape clients get for a sound. */
export const soundCard = (s, { saved = false } = {}) => ({
    _id: s._id,
    source: s.source,
    title: s.title,
    artist: s.artist || '',
    audioUrl: s.audioUrl,
    coverUrl: s.coverUrl || '',
    durationSec: s.durationSec || 0,
    genre: s.genre || '',
    mood: s.mood || '',
    usageCount: s.usageCount || 0,
    allowReuse: s.allowReuse !== false,
    isSaved: !!saved,
    attribution: s.licence?.attribution || '',
    ownerId: s.ownerId || undefined,
});

/** A sound that may go under someone's content now, or an error to show them. */
export const loadUsableSound = async (soundId, userId) => {
    if (!mongoose.Types.ObjectId.isValid(String(soundId))) throw new ApiError(404, 'That song is not available.');
    const sound = await Sound.findOne({ _id: soundId, status: 'active' }).lean();
    if (!sound) throw new ApiError(404, 'That song is not available.');
    if (sound.source === 'original' && sound.allowReuse === false && String(sound.ownerId) !== String(userId)) {
        throw new ApiError(403, 'The creator has turned off reuse of this audio.');
    }
    return sound;
};

/** What a post or story stores about its music. */
export const musicFieldFrom = (sound, choice, { mixed }) => ({
    soundId: sound._id,
    source: sound.source,
    title: sound.title,
    artist: sound.artist || '',
    audioUrl: sound.audioUrl,
    coverUrl: sound.coverUrl || '',
    startSec: choice.startSec ?? 0,
    durationSec: choice.durationSec ?? sound.durationSec ?? 0,
    volume: choice.volume ?? 1,
    mixed: !!mixed,
});

export const bumpSoundUsage = (soundId) =>
    Sound.updateOne({ _id: soundId }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => {});

/**
 * Original audio: the sound of a vibe becomes a sound others can reuse
 * ("Use this audio"), and the vibe gets its "♪ Original audio · @name" label.
 *
 * Skipped for a vibe that already has music, for a duet, when the video has no
 * (or only silent) sound, and when the owner's account is gone. A private
 * account's audio is kept but not offered for reuse.
 *
 * Throws when the video is not downloadable yet (Stream is still encoding), so
 * the queue tries again later.
 */
export const extractOriginalAudio = async (postId, deps = {}) => {
    const d = { ffmpeg: ffmpegSvc, download: downloadToFile, upload: uploadBufferToBunny, ...deps };
    const post = await Post.findById(postId).select('userId postType media music duet status').lean();
    if (!post || !['reel', 'video'].includes(post.postType)) return { skipped: 'not a vibe' };
    if (post.music?.soundId || post.duet?.postId) return { skipped: 'has music or is a duet' };
    if (await Sound.exists({ sourcePostId: post._id })) return { skipped: 'already made' };
    const video = (post.media || []).find((m) => m.type === 'video' && m.url);
    if (!video) return { skipped: 'no video' };
    const owner = await User.findById(post.userId).select('username fullName privacy isFullPrivate accountStatus isDeleted').lean();
    if (!owner || owner.isDeleted || ['deactivated', 'banned'].includes(owner.accountStatus)) return { skipped: 'owner gone' };

    const dir = path.join(editsRoot(), `audio-${postId}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir, { recursive: true });
    try {
        const src = path.join(dir, 'video.mp4');
        await downloadFirst(renditionFallbacks(video.url), src, { maxBytes: 250 * 1024 * 1024 }, d.download);
        const info = await d.ffmpeg.probeMedia(src);
        if (!info.hasAudio || !(info.durationSec >= 1)) return { skipped: 'no audio' };

        const out = path.join(dir, 'original.m4a');
        await d.ffmpeg.runFfmpegOrThrow(buildAudioExtractArgs(src, out), { timeoutMs: 3 * 60 * 1000 });
        if (!hasUsableSound(await d.ffmpeg.measureVolume(out))) return { skipped: 'silent' };

        const probe = await d.ffmpeg.probeMedia(out);
        const buffer = await fsp.readFile(out);
        const uploaded = await d.upload(buffer, 'sounds', 'original.m4a', 'audio/mp4');
        if (!uploaded?.secure_url) throw new Error('Upload returned no URL');

        const isPrivate = owner.privacy === 'private' || owner.isFullPrivate === true;
        const durationSec = Math.round((probe.durationSec || info.durationSec) * 10) / 10;
        let sound;
        try {
            sound = await Sound.create({
                source: 'original',
                title: 'Original audio',
                artist: `@${owner.username}`,
                audioUrl: uploaded.secure_url,
                coverUrl: video.thumbnailUrl || '',
                durationSec,
                ownerId: owner._id,
                sourcePostId: post._id,
                allowReuse: !isPrivate,
                usageCount: 0,
                licence: { type: 'user' },
            });
        } catch (e) {
            if (e?.code === 11000) return { skipped: 'already made' }; // a parallel run won
            throw e;
        }
        await Post.updateOne({ _id: post._id, 'music.soundId': { $exists: false } }, {
            $set: {
                music: {
                    soundId: sound._id, source: 'original', title: sound.title, artist: sound.artist,
                    audioUrl: sound.audioUrl, coverUrl: sound.coverUrl, startSec: 0, durationSec, volume: 1, mixed: true,
                },
            },
        });
        return { created: String(sound._id) };
    } finally {
        await removeWorkDir(dir);
    }
};

// ── The life of an original sound follows its vibe ──────────────────────────

/** The vibe went to the Bin: stop offering its audio. */
export const holdOriginalSound = (postId) =>
    Sound.updateMany({ sourcePostId: postId, source: 'original', status: 'active' }, { $set: { status: 'held' } }).catch(() => {});

/** The vibe was restored from the Bin. */
export const releaseOriginalSound = (postId) =>
    Sound.updateMany({ sourcePostId: postId, source: 'original', status: 'held' }, { $set: { status: 'active' } }).catch(() => {});

/** True when a post or story still plays this sound. */
export const soundIsInUse = async (soundId) =>
    !!(await Post.exists({ 'music.soundId': soundId })) || !!(await Story.exists({ 'music.soundId': soundId }));

/**
 * The vibe was deleted for good. Its audio file goes too, unless other posts
 * still play it; then it is only taken off the shelf and the maintenance job
 * deletes the file once the last of them is gone.
 */
export const retireOriginalSound = async (postId) => {
    const sound = await Sound.findOne({ sourcePostId: postId, source: 'original' }).lean();
    if (!sound) return;
    if (await soundIsInUse(sound._id)) {
        await Sound.updateOne({ _id: sound._id }, { $set: { status: 'removed' } });
        return;
    }
    await deleteSoundForGood(sound);
};

export const deleteSoundForGood = async (sound) => {
    try { await deleteFromBunny(sound.audioUrl); } catch (e) { console.error('[sounds] could not delete file:', e?.message); return; }
    await Promise.all([Sound.deleteOne({ _id: sound._id }), SavedSound.deleteMany({ soundId: sound._id })]);
};
