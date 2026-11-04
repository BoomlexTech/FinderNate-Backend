import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { parseProbe, parseVolumeDetect } from '../utils/phase5.rules.js';

/**
 * The only place that starts FFmpeg.
 *
 * Which binary: FFMPEG_PATH if set, else the one bundled by the optional
 * `ffmpeg-static` package, else `ffmpeg` on the PATH. If none of them runs,
 * isFfmpegAvailable() is false and the editor, music mixing and duets say so
 * instead of failing halfway.
 *
 * Arguments are always passed as an array (no shell), and the callers build
 * them from validated numbers and server-made paths only.
 */

let resolvedPath = null;
let availability = null;

export const resolveFfmpegPath = async () => {
    if (resolvedPath) return resolvedPath;
    if (process.env.FFMPEG_PATH) return (resolvedPath = process.env.FFMPEG_PATH);
    try {
        const mod = await import('ffmpeg-static');
        const bundled = mod.default || mod;
        if (typeof bundled === 'string' && fs.existsSync(bundled)) return (resolvedPath = bundled);
    } catch { /* optional dependency not installed */ }
    return (resolvedPath = 'ffmpeg');
};

/** For tests: forget what was found. */
export const resetFfmpegCache = () => { resolvedPath = null; availability = null; };

const tail = (text, max = 4000) => (text.length > max ? text.slice(text.length - max) : text);

/**
 * Runs FFmpeg. Resolves { code, stderr, stdout } for any exit (the caller
 * decides what a non-zero code means: probing a file prints its details and
 * exits 1 on purpose). Rejects only if the process cannot start or times out.
 *
 * `onProgress(fraction)` is called while rendering when `totalSeconds` is known.
 */
export const runFfmpeg = async (args, { timeoutMs = 10 * 60 * 1000, totalSeconds = 0, onProgress = null } = {}) => {
    const bin = await resolveFfmpegPath();
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            reject(e);
            return;
        }
        // Rendering must not starve the API that shares this machine.
        try { if (child.pid) os.setPriority(child.pid, 10); } catch { /* not allowed here; fine */ }

        let stdout = '';
        let stderr = '';
        let lineBuf = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            const err = new Error('FFmpeg timed out');
            err.code = 'FFMPEG_TIMEOUT';
            reject(err);
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout = tail(stdout + text, 2000);
            if (!onProgress || !(totalSeconds > 0)) return;
            lineBuf += text;
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop();
            for (const line of lines) {
                // out_time_us and out_time_ms are both microseconds in FFmpeg's progress output.
                const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
                if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds));
            }
        });
        child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk.toString()); });
        child.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stderr, stdout });
        });
    });
};

/** Like runFfmpeg, but turns a non-zero exit into an error carrying the log. */
export const runFfmpegOrThrow = async (args, opts) => {
    const res = await runFfmpeg(args, opts);
    if (res.code !== 0) {
        const err = new Error('FFmpeg failed');
        err.code = 'FFMPEG_FAILED';
        err.detail = tail(res.stderr, 1500);
        throw err;
    }
    return res;
};

export const isFfmpegAvailable = async () => {
    if (availability !== null) return availability;
    try {
        const res = await runFfmpeg(['-hide_banner', '-version'], { timeoutMs: 8000 });
        availability = res.code === 0 && /ffmpeg version/i.test(res.stdout + res.stderr);
    } catch {
        availability = false;
    }
    return availability;
};

/** What a media file contains (see parseProbe). Throws if FFmpeg cannot read it at all. */
export const probeMedia = async (path) => {
    const res = await runFfmpeg(['-hide_banner', '-protocol_whitelist', 'file', '-i', path], { timeoutMs: 20000 });
    // `-i` with no output exits 1 after printing the details; that is the normal case.
    const info = parseProbe(res.stderr);
    if (!info.format) {
        const err = new Error('Unreadable media');
        err.code = 'UNREADABLE_MEDIA';
        throw err;
    }
    return info;
};

/** Loudest and average level of a file's audio, to tell silence from sound. */
export const measureVolume = async (path) => {
    const res = await runFfmpeg(['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 60000 });
    return parseVolumeDetect(res.stderr);
};
