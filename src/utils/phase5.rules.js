/**
 * Phase 5 (creator tools): the rules that need no database, no network and no
 * FFmpeg process, so the tests can run them anywhere.
 *
 *   - the reel/duet editor: validating what a client sends, planning the
 *     timeline and building the FFmpeg command (#34, #62, #66, #49, #29)
 *   - music choices on posts, vibes and stories (#29)
 *   - interactive story stickers (#47)
 *   - the photo enhancer's monthly cap (#35)
 *
 * Nothing a client sends ever reaches FFmpeg as text: every number is parsed
 * and clamped, every name (filter, transition, layout) is looked up in a
 * table below, and every path is made by the server. That is what keeps the
 * editor from becoming a way to run arbitrary FFmpeg options.
 */

// ── Limits ──────────────────────────────────────────────────────────────────

export const EDIT_LIMITS = Object.freeze({
    maxClips: 6,
    maxOverlays: 20,
    minClipSeconds: 0.3,
    maxOutputSeconds: 180,
    maxClipMb: 200,
    maxOverlayKb: 2048,
    maxOverlayPixels: 2160 * 3840,
    width: 1080,
    height: 1920,
    fps: 30,
    minSpeed: 0.25,
    maxSpeed: 4,
    maxTransitionSeconds: 1.5,
});

/** Longest background track on a post or vibe, and on a story (seconds). */
export const MUSIC_MAX_SECONDS = Object.freeze({ post: 90, story: 15 });

// ── Colour filters (no SDK, no licence: plain FFmpeg filters) ───────────────

export const FILTER_PRESETS = Object.freeze({
    none: null,
    warm: 'colorbalance=rs=.08:gs=.02:bs=-.08:rm=.05:bm=-.05,eq=saturation=1.1',
    cool: 'colorbalance=rs=-.06:bs=.1:rm=-.03:bm=.05,eq=saturation=1.05',
    vivid: 'eq=saturation=1.5:contrast=1.08',
    fade: 'eq=contrast=0.9:brightness=0.05:saturation=0.85',
    mono: 'hue=s=0,eq=contrast=1.1',
    noir: 'hue=s=0,curves=preset=strong_contrast',
    vintage: 'curves=preset=vintage',
    sunset: 'colorbalance=rs=.15:gs=.02:bs=-.12,eq=saturation=1.2',
});
export const FILTER_NAMES = Object.freeze(Object.keys(FILTER_PRESETS));

// ── Transitions (FFmpeg xfade names; all exist in FFmpeg 5 to 7) ────────────

export const TRANSITIONS = Object.freeze({
    fade: 'fade',
    dissolve: 'dissolve',
    fade_black: 'fadeblack',
    wipe_left: 'wipeleft',
    wipe_right: 'wiperight',
    slide_left: 'slideleft',
    slide_right: 'slideright',
    slide_up: 'slideup',
    slide_down: 'slidedown',
    circle_open: 'circleopen',
    circle_close: 'circleclose',
    pixelize: 'pixelize',
    zoom: 'zoomin',
    radial: 'radial',
});
export const TRANSITION_NAMES = Object.freeze(Object.keys(TRANSITIONS));

export const DUET_LAYOUTS = Object.freeze(['side_by_side', 'top_bottom', 'reaction']);

export class EditValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EditValidationError';
        this.status = 400;
    }
}

// ── Small helpers ───────────────────────────────────────────────────────────

export const clampNum = (value, min, max, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

const r3 = (n) => Math.round(n * 1000) / 1000;
/** A number as it is written into a filter: no exponent, no trailing zeros. */
const fnum = (n) => String(r3(n));

export const formatSeconds = (s) => {
    const total = Math.round(s);
    if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
    const m = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${m} min ${rest} s` : `${m} minute${m === 1 ? '' : 's'}`;
};

/** atempo accepts 0.5 to 2 per stage (in older builds); chain stages beyond that. */
export const atempoChain = (speed) => {
    const stages = [];
    let s = speed;
    while (s < 0.5) { stages.push(0.5); s /= 0.5; }
    while (s > 2) { stages.push(2); s /= 2; }
    stages.push(s);
    return stages.map((x) => `atempo=${fnum(x)}`).join(',');
};

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asArray = (v) => (Array.isArray(v) ? v : []);

export const parseJsonField = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return fallback; }
};

// ── Reading `ffmpeg -i` output (no ffprobe needed) ──────────────────────────

/**
 * What FFmpeg printed to stderr for `ffmpeg -hide_banner -i <file>`.
 * Returns { format, durationSec, hasVideo, hasAudio, width, height, fps }.
 * Width and height are the displayed size (a phone video saved sideways with a
 * rotation tag is reported the right way up).
 */
export const parseProbe = (text = '') => {
    const out = { format: '', durationSec: null, hasVideo: false, hasAudio: false, width: null, height: null, fps: null };
    const fmt = /Input #0, (.+?), (?:from|to) /.exec(text);
    if (fmt) out.format = fmt[1];
    const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    if (dur) out.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);

    const lines = text.split('\n');
    let rotation = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/Stream #0:\d+.*: Video:/.test(line)) {
            if (/\(attached pic\)/.test(line)) continue; // cover art inside an audio file
            if (out.hasVideo) continue;
            out.hasVideo = true;
            const size = /[ ,](\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/.exec(line.replace(/\b0x[0-9a-f]+\b/gi, ''));
            if (size) { out.width = Number(size[1]); out.height = Number(size[2]); }
            const fps = /(\d+(?:\.\d+)?) fps/.exec(line);
            if (fps) out.fps = Number(fps[1]);
            // The rotation tag is printed a line or two below the stream.
            for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                if (/Stream #0:/.test(lines[j])) break;
                const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(lines[j]);
                if (rot) { rotation = Math.abs(Number(rot[1])) % 360; break; }
            }
        } else if (/Stream #0:\d+.*: Audio:/.test(line)) {
            out.hasAudio = true;
        }
    }
    if (rotation === 90 || rotation === 270) [out.width, out.height] = [out.height, out.width];
    return out;
};

const CONTAINERS = Object.freeze({
    video: ['mov', 'mp4', 'matroska', 'webm', 'avi', 'flv', 'mpegts', '3gp', 'asf', 'mpeg'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'mov', 'mp4', 'm4a', 'matroska', 'webm', 'asf', 'amr'],
});

/**
 * Whether FFmpeg's detected container is one we accept for [kind]. A playlist
 * (hls), a concat script or an image sequence can point FFmpeg at other files
 * or addresses, so anything that is not an ordinary media container is refused
 * before it is ever used as an input.
 */
const BLOCKED_DEMUXERS = Object.freeze(['hls', 'applehttp', 'concat', 'image2', 'lavfi', 'rtsp', 'sdp', 'ffmetadata', 'dash']);

export const containerAllowed = (format, kind) => {
    const tokens = String(format || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const allowed = CONTAINERS[kind] || [];
    if (!tokens.length || tokens.some((t) => BLOCKED_DEMUXERS.includes(t))) return false;
    return tokens.some((t) => allowed.includes(t));
};

export const isPng = (buffer) =>
    !!buffer && buffer.length > 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;

/** Pixel size from a PNG's IHDR chunk, or null. */
export const pngSize = (buffer) => {
    if (!isPng(buffer) || buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

// ── Sanitising the edit list (EDL) a client sends ───────────────────────────

const sanitizeCrop = (raw) => {
    const c = asObject(raw);
    if (!('x' in c) && !('width' in c)) return null;
    const x = clampNum(c.x, 0, 0.95, 0);
    const y = clampNum(c.y, 0, 0.95, 0);
    const width = clampNum(c.width, 0.05, 1 - x, 1 - x);
    const height = clampNum(c.height, 0.05, 1 - y, 1 - y);
    if (width >= 0.999 && height >= 0.999) return null;
    return { x: r3(x), y: r3(y), width: r3(width), height: r3(height) };
};

/**
 * Music choice on an edit or a post: { soundId, startSec, durationSec, volume,
 * originalVolume, fadeIn, fadeOut }. The sound itself is looked up by the
 * server; only the window and the volumes come from the client.
 */
export const sanitizeMusicChoice = (raw, { max = MUSIC_MAX_SECONDS.post } = {}) => {
    const m = asObject(raw);
    const soundId = m.soundId || m.sound || m._id || m.id;
    if (!soundId) return null;
    return {
        soundId: String(soundId),
        startSec: r3(clampNum(m.startSec ?? m.start, 0, 60 * 60, 0)),
        durationSec: r3(clampNum(m.durationSec ?? m.duration, 1, max, max)),
        volume: r3(clampNum(m.volume, 0, 1, 1)),
        originalVolume: r3(clampNum(m.originalVolume ?? m.videoVolume, 0, 1, 1)),
        fadeIn: r3(clampNum(m.fadeIn, 0, 5, 0)),
        fadeOut: r3(clampNum(m.fadeOut, 0, 5, 0)),
    };
};

/** The window of a track that can actually be used, given how long it is. */
export const fitMusicWindow = (choice, trackSeconds) => {
    if (!choice) return null;
    const track = Number(trackSeconds);
    if (!Number.isFinite(track) || track <= 0) return choice;
    const startSec = Math.min(choice.startSec, Math.max(0, track - 1));
    const durationSec = Math.max(1, Math.min(choice.durationSec, track - startSec));
    return { ...choice, startSec: r3(startSec), durationSec: r3(durationSec) };
};

/**
 * Turns what a client sent into the only shape the planner accepts.
 *
 * `raw` is the parsed JSON. `clipCount` and `overlayCount` are how many files
 * actually arrived; an index that points past them is an error, not a crash
 * later. A missing `clips` list means "use every uploaded clip whole, in
 * order".
 */
export const sanitizeEdl = (raw, { clipCount, overlayCount = 0, kind = 'reel', maxOutputSeconds = EDIT_LIMITS.maxOutputSeconds } = {}) => {
    const edl = asObject(raw);
    if (!(clipCount >= 1)) throw new EditValidationError('Add at least one video to edit.');
    if (clipCount > EDIT_LIMITS.maxClips) throw new EditValidationError(`You can combine up to ${EDIT_LIMITS.maxClips} clips.`);
    if (kind === 'duet' && clipCount !== 1) throw new EditValidationError('A duet uses one clip: your recording.');
    if (overlayCount > EDIT_LIMITS.maxOverlays) throw new EditValidationError(`You can add up to ${EDIT_LIMITS.maxOverlays} text, sticker or price-tag layers.`);

    const rawClips = asArray(edl.clips).length
        ? asArray(edl.clips)
        : Array.from({ length: clipCount }, (_, i) => ({ input: i }));
    if (rawClips.length > EDIT_LIMITS.maxClips) throw new EditValidationError(`You can combine up to ${EDIT_LIMITS.maxClips} clips.`);

    const clips = rawClips.map((c0, i) => {
        const c = asObject(c0);
        const input = Number.isInteger(Number(c.input)) ? Number(c.input) : i;
        if (input < 0 || input >= clipCount) throw new EditValidationError(`Clip ${i + 1} refers to a video that was not uploaded.`);
        const trimStart = clampNum(c.trimStart ?? c.start, 0, 60 * 60 * 6, 0);
        const rawEnd = c.trimEnd ?? c.end;
        const trimEnd = rawEnd === undefined || rawEnd === null || rawEnd === '' ? null : clampNum(rawEnd, 0, 60 * 60 * 6, null);
        if (trimEnd !== null && trimEnd <= trimStart) throw new EditValidationError(`Clip ${i + 1}: the end has to come after the start.`);
        return {
            input,
            trimStart: r3(trimStart),
            trimEnd: trimEnd === null ? null : r3(trimEnd),
            speed: r3(clampNum(c.speed, EDIT_LIMITS.minSpeed, EDIT_LIMITS.maxSpeed, 1)),
            mute: c.mute === true,
            volume: r3(clampNum(c.volume, 0, 2, 1)),
            filter: FILTER_NAMES.includes(c.filter) ? c.filter : 'none',
            fit: c.fit === 'contain' ? 'contain' : 'cover',
            crop: sanitizeCrop(c.crop),
        };
    });

    const rawTransitions = asArray(edl.transitions);
    const transitions = [];
    for (let i = 0; i < clips.length - 1; i++) {
        const t = asObject(rawTransitions[i]);
        const name = typeof rawTransitions[i] === 'string' ? rawTransitions[i] : t.type;
        if (!name || name === 'none' || !TRANSITION_NAMES.includes(name)) { transitions.push(null); continue; }
        transitions.push({ type: name, duration: r3(clampNum(t.duration, 0.1, EDIT_LIMITS.maxTransitionSeconds, 0.5)) });
    }

    const overlays = asArray(edl.overlays).map((o0, i) => {
        const o = asObject(o0);
        const input = Number.isInteger(Number(o.input)) ? Number(o.input) : i;
        if (input < 0 || input >= overlayCount) throw new EditValidationError(`Layer ${i + 1} refers to an image that was not uploaded.`);
        const start = clampNum(o.start, 0, 60 * 60, 0);
        const rawEnd = o.end;
        const end = rawEnd === undefined || rawEnd === null || rawEnd === '' ? null : clampNum(rawEnd, 0, 60 * 60, null);
        return {
            input,
            x: r3(clampNum(o.x, 0, 1, 0.5)),
            y: r3(clampNum(o.y, 0, 1, 0.5)),
            width: r3(clampNum(o.width ?? o.w, 0.02, 1.5, 0.5)),
            start: r3(start),
            end: end === null || end <= start ? null : r3(end),
        };
    });

    const music = sanitizeMusicChoice(edl.music, { max: MUSIC_MAX_SECONDS.post });
    const coverRaw = clampNum(edl.coverAt, 0, 60 * 60, null);
    const cover = coverRaw === null ? null : r3(coverRaw);

    const out = {
        version: 1,
        kind,
        clips,
        transitions,
        filter: FILTER_NAMES.includes(edl.filter) ? edl.filter : 'none',
        overlays,
        music,
        coverAt: cover,
        maxSeconds: Math.min(maxOutputSeconds, EDIT_LIMITS.maxOutputSeconds),
    };

    if (kind === 'duet') {
        const d = asObject(edl.duet);
        out.duet = {
            layout: DUET_LAYOUTS.includes(d.layout ?? edl.layout) ? (d.layout ?? edl.layout) : 'side_by_side',
            muteOriginal: (d.muteOriginal ?? edl.muteOriginal) === true,
            muteMine: (d.muteMine ?? edl.muteMine) === true,
        };
    }
    return out;
};

// ── Planning the timeline ───────────────────────────────────────────────────

/**
 * `probes` = { clips: [probe, ...], original?: probe } where a probe is the
 * output of parseProbe. Returns everything buildRenderArgs needs, or throws an
 * EditValidationError a person can act on.
 */
export const planEdit = (edl, probes, { width = EDIT_LIMITS.width, height = EDIT_LIMITS.height, fps = EDIT_LIMITS.fps } = {}) => {
    const maxSeconds = edl.maxSeconds || EDIT_LIMITS.maxOutputSeconds;

    if (edl.kind === 'duet') {
        const mine = probes.clips[0];
        const original = probes.original;
        if (!mine || !original) throw new EditValidationError('A duet needs the original video and your clip.');
        const dur = Math.min(mine.durationSec, original.durationSec, maxSeconds);
        if (!(dur >= EDIT_LIMITS.minClipSeconds)) throw new EditValidationError('That clip is too short to use.');
        return {
            kind: 'duet', width, height, fps, total: r3(dur),
            duet: {
                ...edl.duet,
                original: { hasAudio: original.hasAudio },
                mine: { hasAudio: mine.hasAudio },
            },
            filter: edl.filter,
            overlays: edl.overlays,
            music: planMusic(edl.music, dur),
            coverAt: edl.coverAt,
        };
    }

    const clips = edl.clips.map((c, i) => {
        const p = probes.clips[c.input];
        if (!p || !(p.durationSec > 0)) throw new EditValidationError(`Clip ${i + 1} could not be read.`);
        const start = Math.min(c.trimStart, Math.max(0, p.durationSec - EDIT_LIMITS.minClipSeconds));
        const end = Math.min(c.trimEnd ?? p.durationSec, p.durationSec);
        const len = end - start;
        if (!(len >= EDIT_LIMITS.minClipSeconds)) throw new EditValidationError(`Clip ${i + 1} is too short to use.`);
        return { ...c, start: r3(start), len: r3(len), outDur: r3(len / c.speed), hasAudio: p.hasAudio === true };
    });

    const transitions = [];
    for (let i = 0; i < clips.length - 1; i++) {
        const t = edl.transitions[i];
        if (!t) { transitions.push(null); continue; }
        const d = Math.min(t.duration, clips[i].outDur / 2, clips[i + 1].outDur / 2);
        transitions.push(d >= 0.1 ? { type: t.type, duration: r3(d) } : null);
    }

    const total = r3(clips.reduce((s, c) => s + c.outDur, 0) - transitions.reduce((s, t) => s + (t ? t.duration : 0), 0));
    if (total > maxSeconds + 0.05) {
        throw new EditValidationError(`Your video can be up to ${formatSeconds(maxSeconds)}. This one is ${formatSeconds(total)}.`);
    }

    return {
        kind: 'reel', width, height, fps, total, clips, transitions,
        filter: edl.filter,
        overlays: edl.overlays,
        music: planMusic(edl.music, total),
        coverAt: edl.coverAt,
    };
};

const planMusic = (music, total) => {
    if (!music) return null;
    return { ...music, durationSec: r3(Math.min(music.durationSec, total)), volume: music.volume, originalVolume: music.originalVolume };
};

// ── Building the FFmpeg command ─────────────────────────────────────────────

const GLOBAL_ARGS = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y'];

const inputArgs = (path, { seek, duration, loop } = {}) => {
    const a = ['-protocol_whitelist', 'file'];
    if (seek) a.push('-ss', fnum(seek));
    if (duration) a.push('-t', fnum(duration));
    if (loop) a.push('-loop', '1');
    a.push('-i', path);
    return a;
};

const scaleCover = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
const scaleContain = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;

/**
 * Builds the whole FFmpeg argument list for a plan.
 *
 * `files` = { clips: [path], overlays: [path], music: path|null, original: path|null }
 * Returns { args, inputs } where `args` is ready for spawn (no shell involved).
 */
export const buildRenderArgs = (plan, files, outPath, { threads = 0, preset = 'veryfast', crf = 23 } = {}) => {
    const args = [...GLOBAL_ARGS];
    const graph = [];
    const W = plan.width;
    const H = plan.height;
    const fps = plan.fps;
    let next = 0; // next input index

    let vLabel;
    let aLabel;

    if (plan.kind === 'duet') {
        const originalIdx = next++;
        args.push(...inputArgs(files.original, { duration: plan.total }));
        const mineIdx = next++;
        args.push(...inputArgs(files.clips[0], { duration: plan.total }));
        const d = plan.duet;

        const pane = (idx, w, h, label) =>
            `[${idx}:v]setpts=PTS-STARTPTS,fps=${fps},${scaleCover(w, h)},setsar=1[${label}]`;

        if (d.layout === 'top_bottom') {
            graph.push(pane(originalIdx, W, H / 2, 'dl'), pane(mineIdx, W, H / 2, 'dr'));
            graph.push('[dl][dr]vstack=inputs=2[dbase]');
        } else if (d.layout === 'reaction') {
            const pw = Math.round(W * 0.34 / 2) * 2;
            const ph = Math.round(pw * 16 / 9 / 2) * 2;
            graph.push(pane(originalIdx, W, H, 'dl'), pane(mineIdx, pw, ph, 'dr'));
            graph.push(`[dl][dr]overlay=x=main_w-overlay_w-${Math.round(W * 0.04)}:y=main_h-overlay_h-${Math.round(H * 0.1)}[dbase]`);
        } else {
            graph.push(pane(originalIdx, W / 2, H / 2, 'dl'), pane(mineIdx, W / 2, H / 2, 'dr'));
            graph.push(`[dl][dr]hstack=inputs=2,pad=${W}:${H}:0:(oh-ih)/2:color=black[dbase]`);
        }
        vLabel = 'dbase';

        const audioOf = (idx, has, mute, label) => (has && !mute
            ? `[${idx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[${label}]`
            : `anullsrc=r=44100:cl=stereo:d=${fnum(plan.total)}[${label}]`);
        graph.push(audioOf(originalIdx, d.original.hasAudio, d.muteOriginal, 'da0'));
        graph.push(audioOf(mineIdx, d.mine.hasAudio, d.muteMine, 'da1'));
        graph.push('[da0][da1]amix=inputs=2:duration=longest:normalize=0[dabase]');
        aLabel = 'dabase';
    } else {
        // Inputs: every clip first, trimmed at the input so a long file is not decoded whole.
        const clipIdx = plan.clips.map((c) => {
            const idx = next++;
            args.push(...inputArgs(files.clips[c.input], { seek: c.start, duration: c.len }));
            return idx;
        });

        plan.clips.forEach((c, i) => {
            const idx = clipIdx[i];
            const v = [];
            if (c.crop) v.push(`crop=iw*${fnum(c.crop.width)}:ih*${fnum(c.crop.height)}:iw*${fnum(c.crop.x)}:ih*${fnum(c.crop.y)}`);
            v.push(c.speed !== 1 ? `setpts=(PTS-STARTPTS)/${fnum(c.speed)}` : 'setpts=PTS-STARTPTS');
            v.push(`fps=${fps}`);
            v.push(c.fit === 'contain' ? scaleContain(W, H) : scaleCover(W, H));
            if (FILTER_PRESETS[c.filter]) v.push(FILTER_PRESETS[c.filter]);
            v.push('setsar=1', 'format=yuv420p');
            graph.push(`[${idx}:v]${v.join(',')}[v${i}]`);

            if (c.hasAudio && !c.mute) {
                const a = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS'];
                if (c.speed !== 1) a.push(atempoChain(c.speed));
                if (c.volume !== 1) a.push(`volume=${fnum(c.volume)}`);
                graph.push(`[${idx}:a]${a.join(',')}[a${i}]`);
            } else {
                graph.push(`anullsrc=r=44100:cl=stereo:d=${fnum(c.outDur)}[a${i}]`);
            }
        });

        // Join clips one after another, with a cross-fade where one was asked for.
        let vCur = 'v0';
        let aCur = 'a0';
        let running = plan.clips[0].outDur;
        for (let i = 1; i < plan.clips.length; i++) {
            const t = plan.transitions[i - 1];
            const vOut = `vj${i}`;
            const aOut = `aj${i}`;
            if (t) {
                graph.push(`[${vCur}][v${i}]xfade=transition=${TRANSITIONS[t.type]}:duration=${fnum(t.duration)}:offset=${fnum(running - t.duration)}[${vOut}]`);
                graph.push(`[${aCur}][a${i}]acrossfade=d=${fnum(t.duration)}[${aOut}]`);
                running = running + plan.clips[i].outDur - t.duration;
            } else {
                graph.push(`[${vCur}][v${i}]concat=n=2:v=1:a=0[${vOut}]`);
                graph.push(`[${aCur}][a${i}]concat=n=2:v=0:a=1[${aOut}]`);
                running += plan.clips[i].outDur;
            }
            vCur = vOut;
            aCur = aOut;
        }
        vLabel = vCur;
        aLabel = aCur;
    }

    // Whole-video colour filter.
    if (FILTER_PRESETS[plan.filter]) {
        graph.push(`[${vLabel}]${FILTER_PRESETS[plan.filter]}[vfilt]`);
        vLabel = 'vfilt';
    }

    // Text, stickers and price tags are pictures the client drew; place them.
    // A layer that starts after the video ends would never show, so it is skipped.
    const shown = plan.overlays
        .map((o) => ({ ...o, end: o.end === null ? plan.total : Math.min(o.end, plan.total) }))
        .filter((o) => o.start < plan.total && o.end > o.start);
    shown.forEach((o, k) => {
        const idx = next++;
        args.push(...inputArgs(files.overlays[o.input]));
        const ow = Math.max(2, Math.round((o.width * W) / 2) * 2);
        graph.push(`[${idx}:v]format=rgba,scale=${ow}:-2[ov${k}]`);
        const out = `vo${k}`;
        graph.push(
            `[${vLabel}][ov${k}]overlay=x='main_w*${fnum(o.x)}-overlay_w/2':y='main_h*${fnum(o.y)}-overlay_h/2'` +
            `:enable='between(t,${fnum(o.start)},${fnum(o.end)})'[${out}]`
        );
        vLabel = out;
    });
    graph.push(`[${vLabel}]format=yuv420p[vout]`);

    // Music: the chosen window, looped to the length of the video, then mixed.
    if (plan.music && files.music) {
        const m = plan.music;
        const idx = next++;
        args.push(...inputArgs(files.music, { seek: m.startSec, duration: m.durationSec }));
        const chain = [
            'aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS',
            'aloop=loop=-1:size=2147483647', `atrim=0:${fnum(plan.total)}`, 'asetpts=PTS-STARTPTS',
        ];
        if (m.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fnum(Math.min(m.fadeIn, plan.total / 2))}`);
        if (m.fadeOut > 0) {
            const fo = Math.min(m.fadeOut, plan.total / 2);
            chain.push(`afade=t=out:st=${fnum(plan.total - fo)}:d=${fnum(fo)}`);
        }
        chain.push(`volume=${fnum(m.volume)}`);
        graph.push(`[${idx}:a]${chain.join(',')}[mus]`);
        if (m.originalVolume > 0) {
            graph.push(`[${aLabel}]volume=${fnum(m.originalVolume)}[orig]`);
            graph.push('[orig][mus]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]');
        } else {
            // The clip's own sound is turned off, but the stream still has to end somewhere.
            graph.push(`[${aLabel}]anullsink`);
            graph.push('[mus]anull[aout]');
        }
    } else {
        graph.push(`[${aLabel}]anull[aout]`);
    }

    args.push('-filter_complex', graph.join(';'));
    args.push('-map', '[vout]', '-map', '[aout]');
    args.push('-t', fnum(plan.total));
    args.push(
        '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-r', String(fps), '-g', String(fps * 2),
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart', '-f', 'mp4',
    );
    if (threads > 0) args.push('-threads', String(threads));
    args.push(outPath);
    return { args, graph: graph.join(';') };
};

/** One video frame as a JPEG, for the cover. */
export const buildCoverArgs = (videoPath, atSec, outPath) => [
    ...GLOBAL_ARGS.filter((a) => a !== '-progress' && a !== 'pipe:1' && a !== '-nostats'),
    '-protocol_whitelist', 'file', '-ss', fnum(Math.max(0, atSec)), '-i', videoPath,
    '-frames:v', '1', '-q:v', '3', outPath,
];

/** The first seconds of audio from a vibe, as an AAC file (original audio). */
export const buildAudioExtractArgs = (videoPath, outPath, { maxSeconds = 120 } = {}) => [
    ...GLOBAL_ARGS.filter((a) => a !== '-progress' && a !== 'pipe:1' && a !== '-nostats'),
    '-protocol_whitelist', 'file', '-i', videoPath, '-vn', '-t', String(maxSeconds),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-f', 'ipod', outPath,
];

/** From `volumedetect` output: whether there is any sound worth reusing. */
export const parseVolumeDetect = (text = '') => {
    const max = /max_volume: (-?\d+(?:\.\d+)?) dB/.exec(text);
    const mean = /mean_volume: (-?\d+(?:\.\d+)?) dB/.exec(text);
    return { maxDb: max ? Number(max[1]) : null, meanDb: mean ? Number(mean[1]) : null };
};
export const hasUsableSound = ({ maxDb }) => maxDb !== null && maxDb > -45;

// ── Duets ───────────────────────────────────────────────────────────────────

/**
 * Whether a duet of [post] is allowed for [viewerId]. The owner can switch it
 * off per post; private accounts, blocked people and things that are not
 * vibes cannot be dueted.
 */
export const duetBlockReason = ({ post, ownerPrivate = false, blocked = false, viewerId }) => {
    if (!post) return 'That video is not available.';
    if (!['reel', 'video'].includes(post.postType)) return 'Only vibes and videos can be dueted.';
    if (post.status && !['published'].includes(post.status)) return 'That video is not available.';
    const isAuthor = String(post.userId) === String(viewerId);
    if (post.settings?.allowDuets === false && !isAuthor) return 'The creator has turned off duets for this video.';
    if (ownerPrivate && !isAuthor) return 'Duets are not available for private accounts.';
    if (blocked) return "You can't make a duet with this video.";
    if (!post.media?.some((m) => m.type === 'video' && m.url)) return 'That video is not available.';
    return null;
};

// ── Interactive story stickers (#47) ────────────────────────────────────────

export const STICKER_TYPES = Object.freeze(['poll', 'quiz', 'slider', 'countdown', 'question']);
export const MAX_STICKERS_PER_STORY = 5;
export const MAX_QUESTION_ANSWER_LENGTH = 300;

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

const firstEmoji = (v, fallback) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return fallback;
    const seg = typeof Intl !== 'undefined' && Intl.Segmenter
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment)
        : [...s];
    return seg[0] || fallback;
};

const sanitizeOptions = (raw, min, max, label) => {
    const options = asArray(raw).map((o) => cleanText(typeof o === 'string' ? o : o?.text, 30)).filter(Boolean);
    if (options.length < min) throw new EditValidationError(`${label} needs at least ${min} answers.`);
    return options.slice(0, max);
};

/**
 * The stickers a story carries. `newId` makes ids; `now` is for the countdown
 * check. Returns the clean list or throws an error to show the author.
 */
export const sanitizeStickers = (raw, { newId, now = new Date() } = {}) => {
    const list = asArray(raw);
    if (list.length > MAX_STICKERS_PER_STORY) {
        throw new EditValidationError(`A story can have up to ${MAX_STICKERS_PER_STORY} stickers.`);
    }
    const seen = new Set();
    return list.map((s0, i) => {
        const s = asObject(s0);
        if (!STICKER_TYPES.includes(s.type)) throw new EditValidationError(`Sticker ${i + 1} is not a type we support.`);
        const d = asObject(s.data);
        let data;
        if (s.type === 'poll') {
            data = { question: cleanText(d.question, 80), options: sanitizeOptions(d.options && asArray(d.options).length ? d.options : ['Yes', 'No'], 2, 4, 'A poll') };
        } else if (s.type === 'quiz') {
            const options = sanitizeOptions(d.options, 2, 4, 'A quiz');
            const correctIndex = Number(d.correctIndex);
            if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
                throw new EditValidationError('Choose the right answer for your quiz.');
            }
            const question = cleanText(d.question, 80);
            if (!question) throw new EditValidationError('Write the question for your quiz.');
            data = { question, options, correctIndex };
        } else if (s.type === 'slider') {
            data = { question: cleanText(d.question, 80), emoji: firstEmoji(d.emoji, '😍') };
        } else if (s.type === 'countdown') {
            const endsAt = new Date(d.endsAt);
            if (Number.isNaN(endsAt.getTime())) throw new EditValidationError('Pick when the countdown ends.');
            if (endsAt.getTime() <= now.getTime() + 60 * 1000) throw new EditValidationError('The countdown has to end in the future.');
            if (endsAt.getTime() > now.getTime() + 365 * 24 * 3600 * 1000) throw new EditValidationError('A countdown can be up to a year long.');
            data = { title: cleanText(d.title, 40) || 'Countdown', endsAt: endsAt.toISOString() };
        } else {
            data = { prompt: cleanText(d.prompt, 80) || 'Ask me anything' };
        }
        let id = typeof s.id === 'string' && /^[A-Za-z0-9_-]{4,24}$/.test(s.id) ? s.id : (newId ? newId() : `st_${i}`);
        while (seen.has(id)) id = `${id}x`;
        seen.add(id);
        return {
            id,
            type: s.type,
            x: r3(clampNum(s.x, 0, 1, 0.5)),
            y: r3(clampNum(s.y, 0, 1, 0.5)),
            scale: r3(clampNum(s.scale, 0.5, 2.5, 1)),
            rotation: r3(clampNum(s.rotation, -180, 180, 0)),
            data,
        };
    });
};

/**
 * Checks one person's answer to a sticker and returns the fields to store.
 * Throws an error (400) when the answer does not fit the sticker.
 */
export const readStickerAnswer = (sticker, body = {}) => {
    const b = asObject(body);
    const d = sticker.data || {};
    switch (sticker.type) {
        case 'poll':
        case 'quiz': {
            const choice = Number(b.choice);
            if (!Number.isInteger(choice) || choice < 0 || choice >= (d.options || []).length) {
                throw new EditValidationError('Pick one of the answers.');
            }
            return sticker.type === 'quiz' ? { choice, isCorrect: choice === d.correctIndex } : { choice };
        }
        case 'slider': {
            const value = Number(b.value);
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new EditValidationError('Slide to pick a value.');
            return { value: r3(value) };
        }
        case 'countdown':
            return { remind: b.remind !== false };
        case 'question': {
            const text = cleanText(b.text, MAX_QUESTION_ANSWER_LENGTH);
            if (!text) throw new EditValidationError('Write something first.');
            return { text };
        }
        default:
            throw new EditValidationError('That sticker cannot be answered.');
    }
};

/** Counts for one sticker, from its answer rows (small sets and tests). */
export const statsFromRows = (sticker, rows) => {
    const counts = (sticker.data?.options || []).map(() => 0);
    let correctCount = 0;
    let valueSum = 0;
    let reminders = 0;
    for (const r of rows) {
        if (Number.isInteger(r.choice) && counts[r.choice] !== undefined) counts[r.choice]++;
        if (r.isCorrect) correctCount++;
        valueSum += r.value || 0;
        if (r.remindAt) reminders++;
    }
    return { total: rows.length, counts, correctCount, valueSum: r3(valueSum), reminders };
};

/**
 * The same counts from a database $group result: one entry per choice,
 * { choice, n, correct, valueSum, reminders }. Popular stories have thousands
 * of answers, so the database does the counting.
 */
export const statsFromGroups = (sticker, groups) => {
    const counts = (sticker.data?.options || []).map(() => 0);
    let total = 0;
    let correctCount = 0;
    let valueSum = 0;
    let reminders = 0;
    for (const g of groups) {
        total += g.n || 0;
        correctCount += g.correct || 0;
        valueSum += g.valueSum || 0;
        reminders += g.reminders || 0;
        if (Number.isInteger(g.choice) && counts[g.choice] !== undefined) counts[g.choice] += g.n || 0;
    }
    return { total, counts, correctCount, valueSum: r3(valueSum), reminders };
};

/**
 * What a person sees about one sticker.
 *
 * `stats` are the counts (statsFromRows / statsFromGroups), `mine` is the
 * viewer's own answer. The owner always sees results; everyone else sees the
 * results of a poll, quiz or slider only after answering, so the numbers
 * cannot sway them.
 */
export const summarizeSticker = (sticker, stats, mine, isOwner) => {
    const d = sticker.data || {};
    const total = stats?.total || 0;
    const out = { id: sticker.id, type: sticker.type, answered: !!mine };

    if (sticker.type === 'poll' || sticker.type === 'quiz') {
        const counts = (d.options || []).map((_, i) => stats?.counts?.[i] || 0);
        if (mine) out.myChoice = mine.choice;
        if (sticker.type === 'quiz' && mine) { out.isCorrect = !!mine.isCorrect; out.correctIndex = d.correctIndex; }
        if (isOwner || mine) {
            out.total = total;
            out.counts = counts;
            out.percents = counts.map((c) => (total ? Math.round((c / total) * 100) : 0));
            if (sticker.type === 'quiz') {
                out.correctIndex = d.correctIndex;
                out.correctCount = stats?.correctCount || 0;
            }
        }
    } else if (sticker.type === 'slider') {
        if (mine) out.myValue = mine.value;
        if (isOwner || mine) {
            out.total = total;
            out.average = total ? r3((stats?.valueSum || 0) / total) : null;
        }
    } else if (sticker.type === 'countdown') {
        out.isReminded = !!mine && !!mine.remindAt;
        if (isOwner) out.reminders = stats?.reminders || 0;
    } else if (sticker.type === 'question') {
        if (isOwner) out.total = total;
    }
    return out;
};

/**
 * The stickers as other people receive them: the quiz's right answer stays
 * with the owner until someone has answered (it comes back in the summary).
 */
export const stickersForViewer = (stickers, isOwner) =>
    asArray(stickers).map((s) => {
        if (isOwner || s.type !== 'quiz') return s;
        const { correctIndex, ...rest } = s.data || {};
        return { ...s, data: rest };
    });

// ── Photo enhancer (#35) ────────────────────────────────────────────────────

export const ENHANCE_DEFAULT_LIMITS = Object.freeze({ free: 5, small_business: 30, corporate: 100 });
export const ENHANCE_MODES = Object.freeze(['auto', 'remove_background']);

/** The monthly cap for a plan; `overrides` come from admin settings. */
export const enhanceLimitFor = (tier, overrides = {}) => {
    const key = ENHANCE_DEFAULT_LIMITS[tier] === undefined ? 'free' : tier;
    const o = Number(overrides[key]);
    return Number.isFinite(o) && o >= 0 ? Math.floor(o) : ENHANCE_DEFAULT_LIMITS[key];
};

const IST_MS = 330 * 60 * 1000;
/** "2026-11" for the calendar month in India. */
export const istMonthKey = (now = new Date()) => {
    const d = new Date(now.getTime() + IST_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** When the next calendar month starts in India, as a Date. */
export const nextIstMonthStart = (now = new Date()) => {
    const d = new Date(now.getTime() + IST_MS);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - IST_MS);
};

/** A hex colour like #fff or #ffffff as { r, g, b }, else null. */
export const parseHexColor = (v) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
};
