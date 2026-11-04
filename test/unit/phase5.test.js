import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
    EDIT_LIMITS, FILTER_NAMES, FILTER_PRESETS, TRANSITION_NAMES, DUET_LAYOUTS, EditValidationError,
    clampNum, atempoChain, parseProbe, containerAllowed, isPng, pngSize, sanitizeEdl, planEdit, buildRenderArgs,
    buildCoverArgs, buildAudioExtractArgs, sanitizeMusicChoice, fitMusicWindow, duetBlockReason,
    sanitizeStickers, readStickerAnswer, summarizeSticker, enhanceLimitFor, istMonthKey, nextIstMonthStart,
    parseHexColor, parseVolumeDetect, hasUsableSound, formatSeconds, statsFromRows, statsFromGroups, stickersForViewer,
} from '../../src/utils/phase5.rules.js';
import { isFfmpegAvailable, probeMedia, runFfmpeg, measureVolume } from '../../src/services/ffmpeg.service.js';

// ── Pure rules ──────────────────────────────────────────────────────────────

test('clampNum falls back for junk and clamps the rest', () => {
    assert.equal(clampNum('abc', 0, 10, 3), 3);
    assert.equal(clampNum(null, 0, 10, 3), 3);
    assert.equal(clampNum(50, 0, 10, 3), 10);
    assert.equal(clampNum(-5, 0, 10, 3), 0);
    assert.equal(clampNum('4.5', 0, 10, 3), 4.5);
});

test('atempo is chained for speeds outside 0.5 to 2', () => {
    assert.equal(atempoChain(1.5), 'atempo=1.5');
    assert.equal(atempoChain(4), 'atempo=2,atempo=2');
    assert.equal(atempoChain(0.25), 'atempo=0.5,atempo=0.5');
    assert.equal(atempoChain(3), 'atempo=2,atempo=1.5');
});

test('formatSeconds reads naturally', () => {
    assert.equal(formatSeconds(1), '1 second');
    assert.equal(formatSeconds(45), '45 seconds');
    assert.equal(formatSeconds(180), '3 minutes');
    assert.equal(formatSeconds(95), '1 min 35 s');
});

const SAMPLE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1100 kb/s, 29.97 fps, 30 tbr, 15360 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706d), 44100 Hz, stereo, fltp, 128 kb/s (default)
At least one output file must be specified`;

test('parseProbe reads size, duration, audio, and swaps size for a rotated phone video', () => {
    const p = parseProbe(SAMPLE);
    assert.equal(p.format, 'mov,mp4,m4a,3gp,3g2,mj2');
    assert.equal(p.durationSec, 62.5);
    assert.equal(p.hasVideo, true);
    assert.equal(p.hasAudio, true);
    assert.deepEqual([p.width, p.height], [1080, 1920]);
    assert.equal(p.fps, 29.97);
});

test('parseProbe does not mistake cover art in an mp3 for video', () => {
    const p = parseProbe(`Input #0, mp3, from 'a.mp3':
  Duration: 00:03:00.00, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr, 90k tbn (attached pic)`);
    assert.equal(p.hasVideo, false);
    assert.equal(p.hasAudio, true);
});

test('parseProbe keeps the 1080x1920 width when a hex tag sits on the same line', () => {
    const p = parseProbe('Input #0, mov,mp4, from \'x\':\n  Stream #0:0[0x1](und): Video: h264, yuv420p, 1080x1920 [SAR 1:1 DAR 9:16], 30 fps');
    assert.deepEqual([p.width, p.height], [1080, 1920]);
});

test('only ordinary media containers are accepted as inputs', () => {
    assert.ok(containerAllowed('mov,mp4,m4a,3gp,3g2,mj2', 'video'));
    assert.ok(containerAllowed('matroska,webm', 'video'));
    assert.ok(containerAllowed('mp3', 'audio'));
    assert.ok(!containerAllowed('hls', 'video'));
    assert.ok(!containerAllowed('concat', 'video'));
    assert.ok(!containerAllowed('image2', 'video'));
    assert.ok(!containerAllowed('', 'video'));
    assert.ok(!containerAllowed('mp3', 'video'));
});

test('PNG checks look at the file signature and read the size', async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    assert.ok(isPng(png));
    assert.deepEqual(pngSize(png), { width: 30, height: 20 });
    assert.ok(!isPng(Buffer.from('GIF89a................................')));
});

test('sanitizeEdl uses every clip whole when none are listed', () => {
    const edl = sanitizeEdl({}, { clipCount: 2 });
    assert.equal(edl.clips.length, 2);
    assert.deepEqual(edl.clips.map((c) => c.input), [0, 1]);
    assert.equal(edl.clips[0].speed, 1);
    assert.equal(edl.clips[0].trimEnd, null);
    assert.deepEqual(edl.transitions, [null]);
});

test('sanitizeEdl clamps numbers and drops anything it does not recognise', () => {
    const edl = sanitizeEdl({
        clips: [{ input: 0, trimStart: -4, trimEnd: 3, speed: 99, volume: 9, filter: 'none; drawtext=x', fit: 'weird', crop: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 } }, { input: 1 }],
        transitions: [{ type: 'fade; rm -rf', duration: 99 }],
        filter: '../../etc/passwd',
        overlays: [{ input: 0, x: 4, y: -1, width: 99, start: 5, end: 2 }],
        coverAt: 'abc',
    }, { clipCount: 2, overlayCount: 1 });
    assert.equal(edl.clips[0].trimStart, 0);
    assert.equal(edl.clips[0].speed, EDIT_LIMITS.maxSpeed);
    assert.equal(edl.clips[0].volume, 2);
    assert.equal(edl.clips[0].filter, 'none');
    assert.equal(edl.clips[0].fit, 'cover');
    assert.deepEqual(edl.clips[0].crop, { x: 0.2, y: 0.1, width: 0.5, height: 0.5 });
    assert.deepEqual(edl.transitions, [null]);
    assert.equal(edl.filter, 'none');
    assert.deepEqual([edl.overlays[0].x, edl.overlays[0].y, edl.overlays[0].width], [1, 0, 1.5]);
    assert.equal(edl.overlays[0].end, null); // end before start is ignored
    assert.equal(edl.coverAt, null);
});

test('sanitizeEdl rejects missing files, too many clips and a trim that ends before it starts', () => {
    assert.throws(() => sanitizeEdl({}, { clipCount: 0 }), EditValidationError);
    assert.throws(() => sanitizeEdl({}, { clipCount: 7 }), /up to 6 clips/);
    assert.throws(() => sanitizeEdl({ clips: [{ input: 3 }] }, { clipCount: 2 }), /not uploaded/);
    assert.throws(() => sanitizeEdl({ clips: [{ input: 0, trimStart: 5, trimEnd: 2 }] }, { clipCount: 1 }), /end has to come after/);
    assert.throws(() => sanitizeEdl({ overlays: [{ input: 2 }] }, { clipCount: 1, overlayCount: 1 }), /not uploaded/);
    assert.throws(() => sanitizeEdl({}, { clipCount: 2, kind: 'duet' }), /one clip/);
});

test('planEdit adds clip lengths, subtracts transitions and enforces the limit', () => {
    const edl = sanitizeEdl({
        clips: [{ input: 0, trimStart: 1, trimEnd: 5 }, { input: 1, speed: 2 }],
        transitions: [{ type: 'fade', duration: 1 }],
    }, { clipCount: 2 });
    const plan = planEdit(edl, { clips: [{ durationSec: 10, hasAudio: true }, { durationSec: 6, hasAudio: false }] });
    assert.equal(plan.clips[0].outDur, 4);
    assert.equal(plan.clips[1].outDur, 3); // 6 s at 2x
    assert.equal(plan.transitions[0].duration, 1);
    assert.equal(plan.total, 6); // 4 + 3 - 1
    assert.throws(() => planEdit(
        sanitizeEdl({}, { clipCount: 1 }),
        { clips: [{ durationSec: 400, hasAudio: true }] },
    ), /up to 3 minutes/);
});

test('a transition is shortened to fit short clips and dropped when it would be a blink', () => {
    const edl = sanitizeEdl({ clips: [{ input: 0 }, { input: 1 }, { input: 2 }], transitions: [{ type: 'fade', duration: 1.5 }, { type: 'fade', duration: 1 }] }, { clipCount: 3 });
    const plan = planEdit(edl, { clips: [{ durationSec: 1, hasAudio: true }, { durationSec: 1, hasAudio: true }, { durationSec: 0.4, hasAudio: true }] });
    assert.equal(plan.transitions[0].duration, 0.5);
    assert.equal(plan.transitions[1].duration, 0.2);
    const tiny = planEdit(sanitizeEdl({ clips: [{ input: 0, speed: 4 }, { input: 1, speed: 4 }], transitions: [{ type: 'fade', duration: 1 }] }, { clipCount: 2 }),
        { clips: [{ durationSec: 0.4, hasAudio: true }, { durationSec: 0.4, hasAudio: true }] });
    assert.equal(tiny.transitions[0], null);
});

test('every transition and filter the app can offer has a mapping', () => {
    assert.ok(TRANSITION_NAMES.length >= 10);
    assert.ok(FILTER_NAMES.includes('none') && FILTER_NAMES.includes('warm'));
    assert.equal(FILTER_PRESETS.none, null);
});

test('music choice is clamped and fitted to the track', () => {
    const c = sanitizeMusicChoice({ soundId: 'abc', startSec: 500, durationSec: 999, volume: 5, originalVolume: -1, fadeIn: 99 });
    assert.equal(c.durationSec, 90);
    assert.equal(c.volume, 1);
    assert.equal(c.originalVolume, 0);
    assert.equal(c.fadeIn, 5);
    assert.equal(sanitizeMusicChoice({}), null);
    assert.equal(sanitizeMusicChoice({ soundId: 'a', durationSec: 99 }, { max: 15 }).durationSec, 15);
    const fitted = fitMusicWindow({ ...c, startSec: 100 }, 120);
    assert.equal(fitted.startSec, 100);
    assert.equal(fitted.durationSec, 20);
    assert.equal(fitMusicWindow(c, 30).startSec, 29);
});

test('the render command never carries client text', () => {
    const edl = sanitizeEdl({
        clips: [{ input: 0, filter: "x';drawtext=text=hi" }],
        filter: 'vivid,movie=/etc/passwd',
        music: { soundId: 'x' },
    }, { clipCount: 1 });
    const plan = planEdit(edl, { clips: [{ durationSec: 4, hasAudio: true }] });
    const { args, graph } = buildRenderArgs(plan, { clips: ['/tmp/a.mp4'], overlays: [], music: '/tmp/m.mp3' }, '/tmp/out.mp4');
    assert.ok(!/movie|drawtext|passwd/.test(graph));
    assert.ok(args.includes('-protocol_whitelist'));
    assert.equal(args.filter((a) => a === '-i').length, 2);
    assert.equal(args[args.length - 1], '/tmp/out.mp4');
});

test('layers that start after the video ends are not added', () => {
    const edl = sanitizeEdl({ overlays: [{ input: 0, start: 0 }, { input: 1, start: 50 }] }, { clipCount: 1, overlayCount: 2 });
    const plan = planEdit(edl, { clips: [{ durationSec: 4, hasAudio: false }] });
    const { args } = buildRenderArgs(plan, { clips: ['/a.mp4'], overlays: ['/o0.png', '/o1.png'] }, '/out.mp4');
    assert.equal(args.filter((a) => a === '-i').length, 2); // one clip, one visible layer
});

test('cover and audio extraction commands are fixed shapes', () => {
    const cover = buildCoverArgs('/v.mp4', 1.5, '/c.jpg');
    assert.equal(cover[cover.length - 1], '/c.jpg');
    assert.ok(cover.includes('1.5') && cover.includes('-protocol_whitelist'));
    assert.ok(!cover.includes('-progress'));
    const audio = buildAudioExtractArgs('/v.mp4', '/a.m4a');
    assert.ok(audio.includes('-vn'));
    assert.equal(audio[audio.length - 1], '/a.m4a');
});

test('volumedetect output tells silence from sound', () => {
    const loud = parseVolumeDetect('[Parsed_volumedetect_0 @ 0x1] mean_volume: -20.1 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -3.2 dB');
    assert.deepEqual(loud, { maxDb: -3.2, meanDb: -20.1 });
    assert.ok(hasUsableSound(loud));
    assert.ok(!hasUsableSound({ maxDb: -80, meanDb: -90 }));
    assert.ok(!hasUsableSound({ maxDb: null, meanDb: null }));
});

test('duets: who can be dueted', () => {
    const post = { userId: 'a', postType: 'reel', status: 'published', media: [{ type: 'video', url: 'https://cdn/x.mp4' }], settings: {} };
    assert.equal(duetBlockReason({ post, viewerId: 'b' }), null);
    assert.match(duetBlockReason({ post: { ...post, settings: { allowDuets: false } }, viewerId: 'b' }), /turned off/);
    assert.match(duetBlockReason({ post, ownerPrivate: true, viewerId: 'b' }), /private/);
    assert.match(duetBlockReason({ post, blocked: true, viewerId: 'b' }), /can't/);
    assert.match(duetBlockReason({ post: { ...post, postType: 'photo' }, viewerId: 'b' }), /vibes and videos/);
    assert.match(duetBlockReason({ post: { ...post, media: [] }, viewerId: 'b' }), /not available/);
    assert.match(duetBlockReason({ post: { ...post, status: 'draft' }, viewerId: 'b' }), /not available/);
    assert.equal(duetBlockReason({ post: { ...post, settings: { allowDuets: false } }, viewerId: 'a' }), null); // the author is never blocked by their own switch
    assert.deepEqual(DUET_LAYOUTS, ['side_by_side', 'top_bottom', 'reaction']);
});

// ── Story stickers ──────────────────────────────────────────────────────────

const NOW = new Date('2026-11-04T10:00:00Z');
let n = 0;
const newId = () => `st_${++n}`;

test('stickers: each type is cleaned and given an id', () => {
    const list = sanitizeStickers([
        { type: 'poll', x: 0.5, y: 0.4, data: { question: '  Tea or coffee?  ', options: ['Tea', 'Coffee', '', 'x'.repeat(50)] } },
        { type: 'quiz', data: { question: 'Capital of India?', options: ['Delhi', 'Mumbai'], correctIndex: 0 } },
        { type: 'slider', data: { question: 'How much do you love it?', emoji: '🔥🔥' } },
        { type: 'countdown', data: { title: 'Sale', endsAt: '2026-11-10T10:00:00Z' } },
        { type: 'question', data: {} },
    ], { newId, now: NOW });
    assert.equal(list.length, 5);
    assert.equal(list[0].data.question, 'Tea or coffee?');
    assert.equal(list[0].data.options.length, 3);
    assert.equal(list[0].data.options[2].length, 30);
    assert.equal(list[2].data.emoji, '🔥');
    assert.equal(list[3].data.title, 'Sale');
    assert.equal(list[4].data.prompt, 'Ask me anything');
    assert.equal(new Set(list.map((s) => s.id)).size, 5);
});

test('stickers: a poll with no answers gets Yes and No', () => {
    const [s] = sanitizeStickers([{ type: 'poll', data: { question: 'Like it?' } }], { newId, now: NOW });
    assert.deepEqual(s.data.options, ['Yes', 'No']);
});

test('stickers: bad input is refused with something the author can act on', () => {
    assert.throws(() => sanitizeStickers([{ type: 'gif' }], { newId, now: NOW }), /not a type/);
    assert.throws(() => sanitizeStickers([{ type: 'quiz', data: { question: 'q', options: ['a', 'b'], correctIndex: 5 } }], { newId, now: NOW }), /right answer/);
    assert.throws(() => sanitizeStickers([{ type: 'quiz', data: { options: ['a', 'b'], correctIndex: 0 } }], { newId, now: NOW }), /question/);
    assert.throws(() => sanitizeStickers([{ type: 'poll', data: { options: ['only'] } }], { newId, now: NOW }), /at least 2/);
    assert.throws(() => sanitizeStickers([{ type: 'countdown', data: { endsAt: '2026-11-04T10:00:30Z' } }], { newId, now: NOW }), /future/);
    assert.throws(() => sanitizeStickers([{ type: 'countdown', data: { endsAt: 'soon' } }], { newId, now: NOW }), /when the countdown ends/);
    assert.throws(() => sanitizeStickers([{ type: 'countdown', data: { endsAt: '2028-01-01T00:00:00Z' } }], { newId, now: NOW }), /a year/);
    assert.throws(() => sanitizeStickers(Array.from({ length: 6 }, () => ({ type: 'question' })), { newId, now: NOW }), /up to 5/);
    assert.deepEqual(sanitizeStickers(undefined, { newId, now: NOW }), []);
});

test('stickers: answers are checked against the sticker', () => {
    const poll = { type: 'poll', data: { options: ['a', 'b', 'c'] } };
    const quiz = { type: 'quiz', data: { options: ['a', 'b'], correctIndex: 1 } };
    assert.deepEqual(readStickerAnswer(poll, { choice: 2 }), { choice: 2 });
    assert.throws(() => readStickerAnswer(poll, { choice: 3 }), /Pick one/);
    assert.throws(() => readStickerAnswer(poll, {}), /Pick one/);
    assert.deepEqual(readStickerAnswer(quiz, { choice: 1 }), { choice: 1, isCorrect: true });
    assert.deepEqual(readStickerAnswer(quiz, { choice: 0 }), { choice: 0, isCorrect: false });
    assert.deepEqual(readStickerAnswer({ type: 'slider', data: {} }, { value: 0.256 }), { value: 0.256 });
    assert.throws(() => readStickerAnswer({ type: 'slider', data: {} }, { value: 2 }), /Slide/);
    assert.deepEqual(readStickerAnswer({ type: 'countdown', data: {} }, {}), { remind: true });
    assert.deepEqual(readStickerAnswer({ type: 'countdown', data: {} }, { remind: false }), { remind: false });
    assert.deepEqual(readStickerAnswer({ type: 'question', data: {} }, { text: '  hello   there ' }), { text: 'hello there' });
    assert.throws(() => readStickerAnswer({ type: 'question', data: {} }, { text: '   ' }), /Write something/);
    assert.equal(readStickerAnswer({ type: 'question', data: {} }, { text: 'x'.repeat(900) }).text.length, 300);
});

const summary = (sticker, rows, mine, isOwner) => summarizeSticker(sticker, statsFromRows(sticker, rows), mine, isOwner);

test('stickers: results stay hidden until you answer, except for the owner', () => {
    const poll = { id: 'p', type: 'poll', data: { options: ['a', 'b'] } };
    const rows = [{ choice: 0 }, { choice: 0 }, { choice: 1 }];
    const before = summary(poll, rows, null, false);
    assert.equal(before.answered, false);
    assert.equal(before.counts, undefined);
    const after = summary(poll, rows, { choice: 1 }, false);
    assert.deepEqual(after.counts, [2, 1]);
    assert.deepEqual(after.percents, [67, 33]);
    assert.equal(after.myChoice, 1);
    const owner = summary(poll, rows, null, true);
    assert.deepEqual(owner.counts, [2, 1]);
    assert.equal(owner.total, 3);
});

test('stickers: counts from database groups match counts from rows', () => {
    const poll = { id: 'p', type: 'poll', data: { options: ['a', 'b', 'c'] } };
    const groups = [{ choice: 0, n: 5 }, { choice: 2, n: 3 }, { choice: 9, n: 1 }];
    const stats = statsFromGroups(poll, groups);
    assert.deepEqual(stats.counts, [5, 0, 3]);
    assert.equal(stats.total, 9);
    const slider = statsFromGroups({ type: 'slider', data: {} }, [{ choice: null, n: 4, valueSum: 2 }]);
    assert.equal(summarizeSticker({ id: 's', type: 'slider', data: {} }, slider, null, true).average, 0.5);
});

test('stickers: quiz shows the right answer only after answering; slider averages', () => {
    const quiz = { id: 'q', type: 'quiz', data: { options: ['a', 'b'], correctIndex: 1 } };
    assert.equal(summary(quiz, [{ choice: 1, isCorrect: true }], null, false).correctIndex, undefined);
    const done = summary(quiz, [{ choice: 1, isCorrect: true }, { choice: 0, isCorrect: false }], { choice: 0, isCorrect: false }, false);
    assert.equal(done.correctIndex, 1);
    assert.equal(done.isCorrect, false);
    assert.equal(done.correctCount, 1);
    const slider = { id: 's', type: 'slider', data: {} };
    assert.equal(summary(slider, [{ value: 0.2 }, { value: 0.8 }], { value: 0.2 }, false).average, 0.5);
    assert.equal(summary(slider, [], null, true).average, null);
    const q = { id: 'x', type: 'question', data: {} };
    assert.equal(summary(q, [{ text: 'a' }], { text: 'a' }, false).total, undefined);
    assert.equal(summary(q, [{ text: 'a' }], null, true).total, 1);
    const cd = { id: 'c', type: 'countdown', data: {} };
    assert.equal(summary(cd, [{ remindAt: new Date() }, {}], { remindAt: new Date() }, true).reminders, 1);
    assert.equal(summary(cd, [], { remindAt: null }, false).isReminded, false);
});

test('stickers: the quiz answer is not sent to other people', () => {
    const list = [
        { id: 'q', type: 'quiz', data: { question: 'q', options: ['a', 'b'], correctIndex: 1 } },
        { id: 'p', type: 'poll', data: { options: ['a', 'b'] } },
    ];
    const others = stickersForViewer(list, false);
    assert.equal(others[0].data.correctIndex, undefined);
    assert.deepEqual(others[0].data.options, ['a', 'b']);
    assert.equal(others[1], list[1]);
    assert.equal(stickersForViewer(list, true)[0].data.correctIndex, 1);
    assert.equal(list[0].data.correctIndex, 1); // the original is untouched
    assert.deepEqual(stickersForViewer(undefined, false), []);
});

// ── Photo enhancer ──────────────────────────────────────────────────────────

test('enhancer caps per plan, with admin overrides', () => {
    assert.equal(enhanceLimitFor('free'), 5);
    assert.equal(enhanceLimitFor('small_business'), 30);
    assert.equal(enhanceLimitFor('corporate'), 100);
    assert.equal(enhanceLimitFor('mystery'), 5);
    assert.equal(enhanceLimitFor('free', { free: '12' }), 12);
    assert.equal(enhanceLimitFor('free', { free: 'x' }), 5);
    assert.equal(enhanceLimitFor('corporate', { corporate: 0 }), 0);
});

test('the enhancer month follows Indian time', () => {
    assert.equal(istMonthKey(new Date('2026-11-30T18:29:00Z')), '2026-11');
    assert.equal(istMonthKey(new Date('2026-11-30T18:31:00Z')), '2026-12');
    assert.equal(nextIstMonthStart(new Date('2026-11-04T00:00:00Z')).toISOString(), '2026-11-30T18:30:00.000Z');
});

test('hex colours', () => {
    assert.deepEqual(parseHexColor('#fff'), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseHexColor('00ff80'), { r: 0, g: 255, b: 128 });
    assert.equal(parseHexColor('red'), null);
    assert.equal(parseHexColor(''), null);
});

// ── Real FFmpeg renders ─────────────────────────────────────────────────────

const ffmpegOk = await isFfmpegAvailable();
const SMALL = { width: 270, height: 480, fps: 15 };
const SMALL_OPTS = { preset: 'ultrafast', crf: 30 };

const makeFixtures = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5test-'));
    const gen = async (name, args) => {
        const r = await runFfmpeg(['-y', '-loglevel', 'error', ...args, path.join(dir, name)]);
        assert.equal(r.code, 0, r.stderr);
        return path.join(dir, name);
    };
    const withAudio = await gen('a.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    const silent = await gen('b.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
    const music = await gen('m.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libmp3lame']);
    const overlay = path.join(dir, 'o.png');
    await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 255, g: 200, b: 0, alpha: 0.9 } } }).png().toFile(overlay);
    const probes = { a: await probeMedia(withAudio), b: await probeMedia(silent) };
    return { dir, withAudio, silent, music, overlay, probes };
};

const render = async (fx, edlRaw, files, extra = {}, probeOverrides = null) => {
    const clipCount = files.clips.length;
    const edl = sanitizeEdl(edlRaw, { clipCount, overlayCount: (files.overlays || []).length, kind: extra.kind || 'reel' });
    const probes = probeOverrides || { clips: files.clips.map((f) => (f === fx.withAudio ? fx.probes.a : fx.probes.b)), original: extra.original };
    const plan = planEdit(edl, probes, SMALL);
    const out = path.join(fx.dir, `out-${Math.random().toString(36).slice(2)}.mp4`);
    const { args } = buildRenderArgs(plan, { overlays: [], music: null, original: null, ...files }, out, SMALL_OPTS);
    const res = await runFfmpeg(args, { totalSeconds: plan.total });
    assert.equal(res.code, 0, `${res.stderr}\n${args.join(' ')}`);
    return { plan, out, info: await probeMedia(out) };
};

test('render: one clip becomes a 9:16 mp4 with an audio track even if the clip had none', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { info } = await render(fx, {}, { clips: [fx.silent] });
    assert.deepEqual([info.width, info.height], [270, 480]);
    assert.ok(info.hasAudio && info.hasVideo);
    assert.ok(Math.abs(info.durationSec - 3) < 0.15, `duration ${info.durationSec}`);
});

test('render: trim, speed, mute and a hard cut', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { info, plan } = await render(fx, {
        clips: [{ input: 0, trimStart: 1, trimEnd: 3, speed: 2 }, { input: 1, mute: true, trimEnd: 2 }],
    }, { clips: [fx.withAudio, fx.silent] });
    assert.equal(plan.total, 3); // 2 s at 2x = 1 s, plus 2 s
    assert.ok(Math.abs(info.durationSec - 3) < 0.2, `duration ${info.durationSec}`);
});

test('render: every transition name is accepted by FFmpeg', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    for (const type of TRANSITION_NAMES) {
        const { info, plan } = await render(fx, {
            clips: [{ input: 0, trimEnd: 1.5 }, { input: 1, trimEnd: 1.5 }],
            transitions: [{ type, duration: 0.5 }],
        }, { clips: [fx.withAudio, fx.silent] });
        assert.equal(plan.total, 2.5, type);
        assert.ok(Math.abs(info.durationSec - 2.5) < 0.2, `${type}: ${info.durationSec}`);
    }
});

test('render: a transition between three clips, one of them a hard cut', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { plan, info } = await render(fx, {
        clips: [{ input: 0, trimEnd: 1.5 }, { input: 1, trimEnd: 1.5 }, { input: 0, trimStart: 1, trimEnd: 2.5 }],
        transitions: [{ type: 'fade', duration: 0.4 }, null],
    }, { clips: [fx.withAudio, fx.silent] });
    assert.equal(plan.total, 4.1);
    assert.ok(Math.abs(info.durationSec - 4.1) < 0.25, `duration ${info.durationSec}`);
});

test('render: every colour filter works, on a clip and on the whole video', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    for (const filter of FILTER_NAMES) {
        const { info } = await render(fx, { clips: [{ input: 0, trimEnd: 1, filter }], filter }, { clips: [fx.withAudio] });
        assert.ok(info.hasVideo, filter);
    }
});

test('render: crop and contain fit', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { info } = await render(fx, { clips: [{ input: 0, trimEnd: 1, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, fit: 'contain' }] }, { clips: [fx.withAudio] });
    assert.deepEqual([info.width, info.height], [270, 480]);
});

test('render: music is mixed in, looped to the length of the video', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { info, out } = await render(fx, {
        clips: [{ input: 0 }],
        music: { soundId: 'x', startSec: 0, durationSec: 1, volume: 1, originalVolume: 0, fadeOut: 0.5 },
    }, { clips: [fx.silent], music: fx.music });
    assert.ok(Math.abs(info.durationSec - 3) < 0.15, `duration ${info.durationSec}`);
    const level = await measureVolume(out);
    assert.ok(hasUsableSound(level), JSON.stringify(level));
});

test('render: with music at zero and the clip muted, the result is silent', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { out } = await render(fx, { clips: [{ input: 0, mute: true }] }, { clips: [fx.withAudio] });
    assert.ok(!hasUsableSound(await measureVolume(out)));
});

test('render: music over the clip\'s own sound', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { info } = await render(fx, {
        clips: [{ input: 0 }],
        music: { soundId: 'x', startSec: 0.5, durationSec: 1.2, volume: 0.6, originalVolume: 0.8, fadeIn: 0.2, fadeOut: 0.2 },
    }, { clips: [fx.withAudio], music: fx.music });
    assert.ok(info.hasAudio);
    assert.ok(Math.abs(info.durationSec - 3) < 0.15);
});

test('render: a text/sticker layer shows only in its time window', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const { out } = await render(fx, {
        clips: [{ input: 0 }],
        overlays: [{ input: 0, x: 0.5, y: 0.5, width: 0.8, start: 1, end: 2 }],
    }, { clips: [fx.silent], overlays: [fx.overlay] });
    const frame = async (t) => {
        const jpg = path.join(fx.dir, `f${t}.png`);
        await runFfmpeg(['-y', '-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', jpg]);
        const { data } = await sharp(jpg).extract({ left: 135, top: 240, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
        return [...data];
    };
    const during = await frame(1.5);
    const before = await frame(0.4);
    // The layer is amber (255,200,0); the test pattern behind it is not.
    assert.ok(during[0] > 200 && during[2] < 80, `during ${during}`);
    assert.ok(!(before[0] > 200 && before[2] < 80), `before ${before}`);
});

test('render: a duet in each layout, with and without sound on either side', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    for (const layout of DUET_LAYOUTS) {
        const edlRaw = { duet: { layout, muteOriginal: layout === 'reaction' } };
        const edl = sanitizeEdl(edlRaw, { clipCount: 1, kind: 'duet' });
        const plan = planEdit(edl, { clips: [fx.probes.b], original: fx.probes.a }, SMALL);
        const out = path.join(fx.dir, `duet-${layout}.mp4`);
        const { args } = buildRenderArgs(plan, { clips: [fx.silent], overlays: [], original: fx.withAudio }, out, SMALL_OPTS);
        const res = await runFfmpeg(args, { totalSeconds: plan.total });
        assert.equal(res.code, 0, `${layout}: ${res.stderr}`);
        const info = await probeMedia(out);
        assert.deepEqual([info.width, info.height], [270, 480], layout);
        assert.ok(info.hasAudio, layout);
        assert.ok(Math.abs(info.durationSec - 3) < 0.15, `${layout} ${info.durationSec}`);
    }
});

test('extract: original audio comes out as an audio-only file, and silence is detected', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const m4a = path.join(fx.dir, 'orig.m4a');
    const res = await runFfmpeg(buildAudioExtractArgs(fx.withAudio, m4a));
    assert.equal(res.code, 0, res.stderr);
    const info = await probeMedia(m4a);
    assert.ok(info.hasAudio && !info.hasVideo);
    assert.ok(hasUsableSound(await measureVolume(m4a)));
});

test('cover: a frame at the chosen second', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const jpg = path.join(fx.dir, 'c.jpg');
    const res = await runFfmpeg(buildCoverArgs(fx.withAudio, 1.2, jpg));
    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.statSync(jpg).size > 500);
});

test('probing refuses a playlist or a file that is not media', { skip: !ffmpegOk }, async () => {
    const fx = await makeFixtures();
    const bad = path.join(fx.dir, 'x.mp4');
    fs.writeFileSync(bad, 'this is not a video');
    await assert.rejects(() => probeMedia(bad), /Unreadable/);
    const playlist = path.join(fx.dir, 'p.m3u8');
    fs.writeFileSync(playlist, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    let info = null;
    try { info = await probeMedia(playlist); } catch { /* unreadable is fine too */ }
    if (info) assert.ok(!containerAllowed(info.format, 'video'), `format ${info.format}`);
});
