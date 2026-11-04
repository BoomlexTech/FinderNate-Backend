import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import MediaEdit from '../models/mediaEdit.models.js';
import Sound from '../models/sound.models.js';
import Post from '../models/userPost.models.js';
import { uploadBufferToBunny, generateOptimizedImageUrl } from '../utils/bunny.js';
import * as ffmpegSvc from './ffmpeg.service.js';
import { planEdit, buildRenderArgs, buildCoverArgs, duetBlockReason, EditValidationError } from '../utils/phase5.rules.js';

/**
 * Renders a MediaEdit: downloads what is not already on disk (the song, the
 * video being dueted), runs FFmpeg, uploads the finished video and its cover,
 * and records the result for the client to pick up.
 *
 * Anything that touches the network or the disk goes through `deps` so the
 * tests can run this with fakes.
 */

export const editsRoot = () => process.env.EDIT_TMP_DIR || path.join(os.tmpdir(), 'findernate-edits');

const MAX_ATTEMPTS = 2;
const RENDER_TIMEOUT_MS = () => Number(process.env.EDIT_RENDER_TIMEOUT_MS) || 12 * 60 * 1000;

// ── Downloads (our own CDN only) ────────────────────────────────────────────

const hostOf = (value) => {
    if (!value) return null;
    try { return new URL(String(value).includes('://') ? value : `https://${value}`).hostname; } catch { return null; }
};

/**
 * Only files on our own CDN hosts are ever fetched. The URLs come from our
 * database, but a post URL is user-influenced data, so the host is checked
 * exactly (a substring check would let "https://evil.example/?https://cdn…" in).
 */
export const isTrustedMediaUrl = (url) => {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return false;
        const hosts = [hostOf(process.env.BUNNY_CDN_URL), hostOf(process.env.BUNNY_STREAM_CDN_HOST)].filter(Boolean);
        return hosts.includes(u.hostname);
    } catch {
        return false;
    }
};

/** Stream only encodes the sizes it needs; fall back to a smaller one when the first is missing. */
export const renditionFallbacks = (url) => {
    const m = /play_(\d+)p\.mp4/.exec(url || '');
    if (!m) return [url];
    const order = [1080, 720, 480, 360, 240];
    const start = Math.max(0, order.indexOf(Number(m[1])));
    return order.slice(start).map((h) => url.replace(/play_\d+p\.mp4/, `play_${h}p.mp4`));
};

export const downloadToFile = async (url, dest, { maxBytes = 200 * 1024 * 1024, timeoutMs = 120000 } = {}) => {
    if (!isTrustedMediaUrl(url)) throw new EditValidationError('That file is not available.');
    let res;
    try {
        res = await axios.get(url, { responseType: 'stream', timeout: timeoutMs, maxRedirects: 0, validateStatus: (s) => s === 200 });
    } catch (e) {
        const err = new Error(`Download failed (${e.response?.status || e.code || e.message})`);
        err.status = e.response?.status;
        throw err;
    }
    let size = 0;
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        res.data.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) res.data.destroy(new EditValidationError('That file is too large to use.'));
        });
        res.data.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.data.pipe(out);
    });
    return size;
};

/** Downloads the first URL that exists. */
export const downloadFirst = async (urls, dest, opts, download = downloadToFile) => {
    let last;
    for (const url of urls) {
        try { return await download(url, dest, opts); } catch (e) {
            last = e;
            if (e instanceof EditValidationError || (e.status && e.status !== 404)) throw e;
        }
    }
    throw last || new Error('Download failed');
};

export const removeWorkDir = async (dir) => {
    if (!dir) return;
    const root = path.resolve(editsRoot());
    const target = path.resolve(dir);
    if (!target.startsWith(root + path.sep)) return; // never delete outside our own folder
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
};

// ── The job ─────────────────────────────────────────────────────────────────

const friendly = (err) => {
    if (err instanceof EditValidationError) return err.message;
    if (err?.code === 'FFMPEG_TIMEOUT') return 'That took too long to process. Try a shorter video or fewer effects.';
    if (err?.code === 'FFMPEG_FAILED') return "We couldn't process those clips. Try different videos or fewer effects.";
    return 'Something went wrong while preparing your video. Please try again.';
};

const permanent = (err) => err instanceof EditValidationError || err?.code === 'FFMPEG_FAILED' || err?.code === 'FFMPEG_TIMEOUT';

/**
 * Runs one edit. Returns { status }. Throws only for a failure worth retrying
 * (the queue then runs it again); everything else is recorded on the edit.
 */
export const runEdit = async (editId, deps = {}) => {
    const d = {
        ffmpeg: ffmpegSvc,
        download: downloadToFile,
        upload: uploadBufferToBunny,
        ...deps,
    };

    const edit = await MediaEdit.findOneAndUpdate(
        { _id: editId, status: 'queued' },
        { $set: { status: 'processing', startedAt: new Date(), progress: 1, error: '' }, $inc: { attempts: 1 } },
        { new: true }
    );
    if (!edit) return { status: 'skipped' };

    const dir = edit.workDir;
    try {
        const files = { clips: edit.files?.clips || [], overlays: edit.files?.overlays || [], music: null, original: null };
        const probes = { clips: edit.probes?.clips || [] };

        if (edit.edl?.music?.soundId) {
            const sound = await Sound.findOne({ _id: edit.edl.music.soundId, status: 'active' }).select('audioUrl').lean();
            if (!sound?.audioUrl) throw new EditValidationError('That song is no longer available. Pick another one.');
            files.music = path.join(dir, 'music');
            await d.download(sound.audioUrl, files.music, { maxBytes: 40 * 1024 * 1024 });
        }

        if (edit.kind === 'duet') {
            const post = await Post.findById(edit.duet?.postId).select('userId postType status media settings').lean();
            const reason = duetBlockReason({ post, viewerId: edit.userId });
            if (reason) throw new EditValidationError(reason);
            const video = post.media.find((m) => m.type === 'video' && m.url);
            files.original = path.join(dir, 'original.mp4');
            await downloadFirst(renditionFallbacks(video.url), files.original, { maxBytes: 250 * 1024 * 1024 }, d.download);
            probes.original = await d.ffmpeg.probeMedia(files.original);
            if (!probes.original.hasVideo) throw new EditValidationError('That video is not available.');
        }

        const plan = planEdit(edit.edl, probes, {
            width: Number(process.env.EDIT_OUTPUT_WIDTH) || undefined,
            height: Number(process.env.EDIT_OUTPUT_HEIGHT) || undefined,
        });

        const outPath = path.join(dir, 'out.mp4');
        const { args } = buildRenderArgs(plan, files, outPath, {
            threads: Number(process.env.EDIT_FFMPEG_THREADS) || 0,
            preset: process.env.EDIT_FFMPEG_PRESET || 'veryfast',
            crf: Number(process.env.EDIT_FFMPEG_CRF) || 23,
        });

        let lastSaved = 0;
        let lastAt = 0;
        await d.ffmpeg.runFfmpegOrThrow(args, {
            timeoutMs: RENDER_TIMEOUT_MS(),
            totalSeconds: plan.total,
            onProgress: (fraction) => {
                const pct = Math.min(90, Math.max(1, Math.round(fraction * 90)));
                if (pct - lastSaved >= 5 && Date.now() - lastAt > 1500) {
                    lastSaved = pct;
                    lastAt = Date.now();
                    MediaEdit.updateOne({ _id: edit._id }, { $set: { progress: pct } }).catch(() => {});
                }
            },
        });

        // Cover: the chosen second, else a moment into the video.
        const coverPath = path.join(dir, 'cover.jpg');
        const coverAt = Math.min(plan.coverAt ?? Math.min(1, plan.total / 2), Math.max(0, plan.total - 0.1));
        await d.ffmpeg.runFfmpegOrThrow(buildCoverArgs(outPath, coverAt, coverPath), { timeoutMs: 60000 });

        await MediaEdit.updateOne({ _id: edit._id }, { $set: { progress: 93 } });
        const [video, cover] = await Promise.all([fsp.readFile(outPath), fsp.readFile(coverPath)]);
        const uploadedVideo = await d.upload(video, 'posts', 'edit.mp4');
        let coverUrl = null;
        try {
            const uploadedCover = await d.upload(cover, 'posts', 'cover.jpg');
            coverUrl = uploadedCover?.secure_url || null;
        } catch { /* the video's own thumbnail is used instead */ }

        if (!uploadedVideo?.secure_url) throw new Error('Upload returned no URL');
        await MediaEdit.updateOne({ _id: edit._id }, {
            $set: {
                status: 'done',
                progress: 100,
                finishedAt: new Date(),
                result: {
                    type: 'video',
                    url: uploadedVideo.secure_url,
                    thumbnailUrl: coverUrl ? generateOptimizedImageUrl(coverUrl, { width: 300, height: 300, crop: 'fill' }) : (uploadedVideo.thumbnailUrl || null),
                    coverUrl,
                    duration: plan.total,
                    width: plan.width,
                    height: plan.height,
                    fileSize: video.length,
                    format: 'mp4',
                    processing: uploadedVideo.processing === true,
                },
            },
        });
        await removeWorkDir(dir);
        return { status: 'done' };
    } catch (err) {
        const retry = !permanent(err) && edit.attempts < MAX_ATTEMPTS;
        if (retry) {
            await MediaEdit.updateOne({ _id: edit._id }, { $set: { status: 'queued', progress: 0 } });
            throw err; // the queue runs it again
        }
        await MediaEdit.updateOne({ _id: edit._id }, {
            $set: {
                status: 'failed',
                finishedAt: new Date(),
                error: friendly(err),
                errorDetail: String(err?.detail || err?.message || '').slice(0, 1500),
            },
        });
        await removeWorkDir(dir);
        console.error(`[edit ${edit._id}] failed:`, err?.message, err?.detail || '');
        return { status: 'failed' };
    }
};
