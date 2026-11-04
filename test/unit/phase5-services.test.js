import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import MediaEdit from '../../src/models/mediaEdit.models.js';
import Sound from '../../src/models/sound.models.js';
import Post from '../../src/models/userPost.models.js';
import EnhanceUsage from '../../src/models/enhanceUsage.models.js';
import Subscription from '../../src/models/subscription.models.js';
import Setting from '../../src/models/settings.models.js';
import { User } from '../../src/models/user.models.js';
import { sanitizeEdl } from '../../src/utils/phase5.rules.js';
import { isFfmpegAvailable, probeMedia, runFfmpeg } from '../../src/services/ffmpeg.service.js';
import {
    runEdit, isTrustedMediaUrl, renditionFallbacks, removeWorkDir, editsRoot, downloadFirst,
} from '../../src/services/mediaRender.service.js';
import { extractOriginalAudio } from '../../src/services/sounds.service.js';
import { brightnessLift, enhanceLocally, placeOnBackground, luminanceOf } from '../../src/utils/photoEnhance.utils.js';
import { enhancePhoto, getEnhanceConfig } from '../../src/controllers/enhance.controllers.js';
import { clearSettingCache } from '../../src/utils/appSettings.utils.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p5svc-'));
process.env.EDIT_TMP_DIR = path.join(TMP, 'edits');
process.env.EDIT_OUTPUT_WIDTH = '270';
process.env.EDIT_OUTPUT_HEIGHT = '480';
process.env.EDIT_FFMPEG_PRESET = 'ultrafast';
process.env.EDIT_FFMPEG_CRF = '32';
fs.mkdirSync(process.env.EDIT_TMP_DIR, { recursive: true });

afterEach(() => { mock.restoreAll(); clearSettingCache(); });

const chain = (value) => ({ select: () => chain(value), populate: () => chain(value), lean: async () => value, then: (res, rej) => Promise.resolve(value).then(res, rej) });
const ffmpegOk = await isFfmpegAvailable();

// ── Fixtures ────────────────────────────────────────────────────────────────

let fixtures;
const getFixtures = async () => {
    if (fixtures) return fixtures;
    const dir = path.join(TMP, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const gen = async (name, args) => {
        const r = await runFfmpeg(['-y', '-loglevel', 'error', ...args, path.join(dir, name)]);
        assert.equal(r.code, 0, r.stderr);
        return path.join(dir, name);
    };
    const withAudio = await gen('a.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    const silent = await gen('s.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=30:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
    const quiet = await gen('q.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const music = await gen('m.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:a', 'libmp3lame']);
    fixtures = { dir, withAudio, silent, quiet, music, probes: { a: await probeMedia(withAudio), s: await probeMedia(silent) } };
    return fixtures;
};

const makeEdit = async (fx, { kind = 'reel', edlRaw = {}, clips = [fx.withAudio], duet, attempts = 1 } = {}) => {
    const id = `edit${Math.random().toString(36).slice(2, 8)}`;
    const workDir = path.join(editsRoot(), id);
    fs.mkdirSync(workDir, { recursive: true });
    const files = clips.map((src, i) => { const dest = path.join(workDir, `clip${i}`); fs.copyFileSync(src, dest); return dest; });
    const edl = sanitizeEdl(edlRaw, { clipCount: clips.length, overlayCount: 0, kind });
    const probes = { clips: await Promise.all(clips.map((c) => probeMedia(c))) };
    return { _id: id, userId: 'user1', kind, status: 'processing', attempts, edl, probes, workDir, files: { clips: files, overlays: [] }, duet };
};

const updates = [];
const fakeStore = (edit) => {
    updates.length = 0;
    mock.method(MediaEdit, 'findOneAndUpdate', async () => edit);
    mock.method(MediaEdit, 'updateOne', async (filter, update) => { updates.push(update.$set || update); return { modifiedCount: 1 }; });
};
const finalState = () => Object.assign({}, ...updates);

const deps = (fx, { musicFile = fx.music, upload } = {}) => ({
    download: async (url, dest) => {
        if (/\.mp3|sounds/.test(url)) fs.copyFileSync(musicFile, dest);
        else fs.copyFileSync(fx.withAudio, dest);
        return 1;
    },
    upload: upload || (async (buffer, folder, name) => ({ secure_url: `https://cdn.test/${folder}/${name}`, thumbnailUrl: null, processing: false, bytes: buffer.length })),
});

// ── runEdit ─────────────────────────────────────────────────────────────────

test('runEdit: renders the clips with music, uploads video and cover, records the result, clears the work folder', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const edit = await makeEdit(fx, {
        clips: [fx.withAudio, fx.silent],
        edlRaw: {
            clips: [{ input: 0, trimEnd: 2 }, { input: 1, trimEnd: 2 }],
            transitions: [{ type: 'fade', duration: 0.5 }],
            music: { soundId: 'sound1', startSec: 0, durationSec: 2, volume: 0.8, originalVolume: 0.6 },
            coverAt: 1,
        },
    });
    fakeStore(edit);
    mock.method(Sound, 'findOne', () => chain({ audioUrl: 'https://cdn.test/sounds/track.mp3' }));
    const uploads = [];
    const res = await runEdit(edit._id, deps(fx, {
        upload: async (buffer, folder, name) => { uploads.push({ folder, name, size: buffer.length }); return { secure_url: `https://cdn.test/${folder}/${name}`, processing: true }; },
    }));
    assert.equal(res.status, 'done');
    const state = finalState();
    assert.equal(state.status, 'done');
    assert.equal(state.progress, 100);
    assert.equal(state.result.url, 'https://cdn.test/posts/edit.mp4');
    assert.equal(state.result.coverUrl, 'https://cdn.test/posts/cover.jpg');
    assert.equal(state.result.processing, true);
    assert.equal(state.result.duration, 3.5); // 2 + 2 - 0.5
    assert.deepEqual([state.result.width, state.result.height], [270, 480]);
    assert.deepEqual(uploads.map((u) => u.name), ['edit.mp4', 'cover.jpg']);
    assert.ok(uploads[0].size > 1000 && uploads[1].size > 200);
    assert.equal(fs.existsSync(edit.workDir), false, 'the work folder is removed');
});

test('runEdit: a song that is gone fails the edit with a message, without retrying', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const edit = await makeEdit(fx, { edlRaw: { music: { soundId: 'gone' } } });
    fakeStore(edit);
    mock.method(Sound, 'findOne', () => chain(null));
    const res = await runEdit(edit._id, deps(fx));
    assert.equal(res.status, 'failed');
    assert.match(finalState().error, /no longer available/);
    assert.equal(fs.existsSync(edit.workDir), false);
});

test('runEdit: a network hiccup is retried once, then the edit fails', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const broken = { ...deps(fx), upload: async () => { throw new Error('socket hang up'); } };

    const first = await makeEdit(fx, { attempts: 1 });
    fakeStore(first);
    await assert.rejects(() => runEdit(first._id, broken), /socket hang up/);
    assert.equal(finalState().status, 'queued', 'put back for the queue to try again');

    const second = await makeEdit(fx, { attempts: 2 });
    fakeStore(second);
    const res = await runEdit(second._id, broken);
    assert.equal(res.status, 'failed');
    assert.match(finalState().error, /Something went wrong/);
});

test('runEdit: an edit that was already taken is skipped', async () => {
    mock.method(MediaEdit, 'findOneAndUpdate', async () => null);
    assert.deepEqual(await runEdit('x'), { status: 'skipped' });
});

test('runEdit: a clip the planner cannot use fails with its message', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const edit = await makeEdit(fx, { edlRaw: { clips: [{ input: 0, trimStart: 0, trimEnd: 0.1 }] } });
    fakeStore(edit);
    const res = await runEdit(edit._id, deps(fx));
    assert.equal(res.status, 'failed');
    assert.match(finalState().error, /too short/);
});

test('runEdit: a duet falls back to a smaller rendition when the first is missing', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const edit = await makeEdit(fx, {
        kind: 'duet', clips: [fx.silent], edlRaw: { duet: { layout: 'top_bottom' } },
        duet: { postId: 'orig1', authorId: 'author', authorUsername: 'asha', layout: 'top_bottom' },
    });
    fakeStore(edit);
    mock.method(Post, 'findById', () => chain({
        _id: 'orig1', userId: 'author', postType: 'reel', status: 'published', settings: {},
        media: [{ type: 'video', url: 'https://cdn.test/guid/play_720p.mp4' }],
    }));
    const tried = [];
    const d = deps(fx);
    const res = await runEdit(edit._id, {
        ...d,
        download: async (url, dest, opts) => {
            tried.push(url);
            if (url.includes('play_720p')) { const e = new Error('nope'); e.status = 404; throw e; }
            return d.download(url, dest, opts);
        },
    });
    assert.equal(res.status, 'done', finalState().error);
    assert.deepEqual(tried, ['https://cdn.test/guid/play_720p.mp4', 'https://cdn.test/guid/play_480p.mp4']);
    assert.equal(finalState().result.duration, 3);
});

test('runEdit: a duet of a video whose creator switched duets off is refused', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const edit = await makeEdit(fx, {
        kind: 'duet', clips: [fx.silent], edlRaw: { duet: { layout: 'side_by_side' } },
        duet: { postId: 'orig1', authorId: 'author', authorUsername: 'asha', layout: 'side_by_side' },
    });
    fakeStore(edit);
    mock.method(Post, 'findById', () => chain({
        _id: 'orig1', userId: 'author', postType: 'reel', status: 'published', settings: { allowDuets: false },
        media: [{ type: 'video', url: 'https://cdn.test/guid/play_720p.mp4' }],
    }));
    const res = await runEdit(edit._id, deps(fx));
    assert.equal(res.status, 'failed');
    assert.match(finalState().error, /turned off duets/);
});

// ── Downloads and folders ───────────────────────────────────────────────────

test('only our own CDN hosts are downloaded, matched exactly', () => {
    process.env.BUNNY_CDN_URL = 'https://cdn.findernate.test';
    process.env.BUNNY_STREAM_CDN_HOST = 'vz-123.b-cdn.test';
    assert.ok(isTrustedMediaUrl('https://cdn.findernate.test/posts/a.mp4'));
    assert.ok(isTrustedMediaUrl('https://vz-123.b-cdn.test/guid/play_720p.mp4'));
    assert.ok(!isTrustedMediaUrl('http://cdn.findernate.test/a.mp4'));
    assert.ok(!isTrustedMediaUrl('https://evil.test/?https://cdn.findernate.test/a.mp4'));
    assert.ok(!isTrustedMediaUrl('https://cdn.findernate.test.evil.test/a.mp4'));
    assert.ok(!isTrustedMediaUrl('file:///etc/passwd'));
    assert.ok(!isTrustedMediaUrl('not a url'));
});

test('renditions are tried from the one stored down to the smallest', () => {
    assert.deepEqual(renditionFallbacks('https://c/g/play_720p.mp4'), [
        'https://c/g/play_720p.mp4', 'https://c/g/play_480p.mp4', 'https://c/g/play_360p.mp4', 'https://c/g/play_240p.mp4',
    ]);
    assert.deepEqual(renditionFallbacks('https://c/posts/x.mp4'), ['https://c/posts/x.mp4']);
});

test('downloadFirst stops at a real failure instead of trying every rendition', async () => {
    const calls = [];
    await assert.rejects(() => downloadFirst(['a', 'b', 'c'], '/x', {}, async (u) => { calls.push(u); const e = new Error('boom'); e.status = 500; throw e; }), /boom/);
    assert.deepEqual(calls, ['a']);
    const ok = await downloadFirst(['a', 'b'], '/x', {}, async (u) => { if (u === 'a') { const e = new Error('x'); e.status = 404; throw e; } return 7; });
    assert.equal(ok, 7);
});

test('removeWorkDir never deletes outside the edits folder', async () => {
    const outside = fs.mkdtempSync(path.join(TMP, 'keep-'));
    fs.writeFileSync(path.join(outside, 'f'), 'x');
    await removeWorkDir(outside);
    assert.ok(fs.existsSync(path.join(outside, 'f')));
    await removeWorkDir(path.join(editsRoot(), '..', 'edits-evil'));
    const inside = path.join(editsRoot(), 'job1');
    fs.mkdirSync(inside, { recursive: true });
    await removeWorkDir(inside);
    assert.ok(!fs.existsSync(inside));
    await removeWorkDir(editsRoot()); // the root itself stays
    assert.ok(fs.existsSync(editsRoot()));
});

// ── Original audio ──────────────────────────────────────────────────────────

const postDoc = (over = {}) => ({
    _id: 'post1', userId: 'u1', postType: 'reel', status: 'published',
    media: [{ type: 'video', url: 'https://cdn.test/guid/play_720p.mp4', thumbnailUrl: 'https://cdn.test/t.jpg' }], ...over,
});
const ownerDoc = (over = {}) => ({ _id: 'u1', username: 'asha', privacy: 'public', ...over });

const audioMocks = ({ post = postDoc(), owner = ownerDoc(), exists = null } = {}) => {
    mock.method(Post, 'findById', () => chain(post));
    mock.method(User, 'findById', () => chain(owner));
    mock.method(Sound, 'exists', async () => exists);
    const created = [];
    mock.method(Sound, 'create', async (doc) => { created.push(doc); return { ...doc, _id: 'sound1' }; });
    const postUpdates = [];
    mock.method(Post, 'updateOne', async (filter, update) => { postUpdates.push({ filter, update }); return {}; });
    return { created, postUpdates };
};

const audioDeps = (fx, file) => ({
    download: async (url, dest) => { fs.copyFileSync(file, dest); return 1; },
    upload: async (buffer, folder, name, mime) => ({ secure_url: `https://cdn.test/${folder}/${name}`, mime, size: buffer.length }),
});

test('original audio: a vibe with sound becomes a reusable sound and gets its label', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const { created, postUpdates } = audioMocks();
    const res = await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio));
    assert.deepEqual(res, { created: 'sound1' });
    assert.equal(created.length, 1);
    assert.equal(created[0].source, 'original');
    assert.equal(created[0].title, 'Original audio');
    assert.equal(created[0].artist, '@asha');
    assert.equal(created[0].allowReuse, true);
    assert.equal(created[0].audioUrl, 'https://cdn.test/sounds/original.m4a');
    assert.ok(created[0].durationSec >= 2.5 && created[0].durationSec <= 3.5);
    assert.equal(postUpdates[0].update.$set.music.title, 'Original audio');
    assert.equal(postUpdates[0].update.$set.music.mixed, true);
    assert.deepEqual(postUpdates[0].filter, { _id: 'post1', 'music.soundId': { $exists: false } });
});

test('original audio: a private account\'s sound is kept but not offered for reuse', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    const { created } = audioMocks({ owner: ownerDoc({ privacy: 'private' }) });
    await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio));
    assert.equal(created[0].allowReuse, false);
});

test('original audio: silent videos, videos with no sound, and vibes that already have music are skipped', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    let m = audioMocks();
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.silent)), { skipped: 'no audio' });
    mock.restoreAll();
    m = audioMocks();
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.quiet)), { skipped: 'silent' });
    assert.equal(m.created.length, 0);
    mock.restoreAll();
    audioMocks({ post: postDoc({ music: { soundId: 'x' } }) });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'has music or is a duet' });
    mock.restoreAll();
    audioMocks({ post: postDoc({ duet: { postId: 'o' } }) });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'has music or is a duet' });
    mock.restoreAll();
    audioMocks({ exists: { _id: 'already' } });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'already made' });
    mock.restoreAll();
    audioMocks({ post: postDoc({ postType: 'photo' }) });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'not a vibe' });
    mock.restoreAll();
    audioMocks({ owner: ownerDoc({ isDeleted: true }) });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'owner gone' });
});

test('original audio: a video that cannot be downloaded yet makes the queue try again', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    audioMocks();
    await assert.rejects(() => extractOriginalAudio('post1', {
        ...audioDeps(fx, fx.withAudio),
        download: async () => { const e = new Error('Download failed (404)'); e.status = 404; throw e; },
    }), /404/);
});

test('original audio: two runs at once make one sound', { skip: !ffmpegOk }, async () => {
    const fx = await getFixtures();
    audioMocks();
    mock.method(Sound, 'create', async () => { const e = new Error('dup'); e.code = 11000; throw e; });
    assert.deepEqual(await extractOriginalAudio('post1', audioDeps(fx, fx.withAudio)), { skipped: 'already made' });
});

// ── Photo enhancer ──────────────────────────────────────────────────────────

const solid = (r, g, b, w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const stripes = async (dark) => {
    const lo = dark ? 25 : 90;
    const hi = dark ? 70 : 200;
    const raw = Buffer.alloc(400 * 300 * 3);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
        const v = x % 40 < 20 ? lo : hi;
        const i = (y * 400 + x) * 3;
        raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
    return sharp(raw, { raw: { width: 400, height: 300, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
};
const meanLuminance = async (buf) => luminanceOf(await sharp(buf).stats());

test('enhancer: dark photos are lifted by more than bright ones, never darkened', () => {
    assert.equal(brightnessLift(115), 1);
    assert.equal(brightnessLift(200), 1);
    assert.ok(brightnessLift(40) > brightnessLift(80));
    assert.ok(brightnessLift(0) <= 1.5);
    assert.equal(brightnessLift(NaN), 1);
});

test('enhancer: a dark photo comes out lighter and keeps its shape', async () => {
    const input = await stripes(true);
    const out = await enhanceLocally(input);
    assert.equal(out.format, 'jpeg');
    assert.deepEqual([out.width, out.height], [400, 300]);
    assert.ok(await meanLuminance(out.buffer) > await meanLuminance(input) + 15);
});

test('enhancer: a well-lit photo is left about as bright as it was', async () => {
    const input = await stripes(false);
    const out = await enhanceLocally(input);
    const before = await meanLuminance(input);
    const after = await meanLuminance(out.buffer);
    assert.ok(Math.abs(after - before) < 40, `${before} -> ${after}`);
});

test('enhancer: large photos are brought down to 2048 on the long side', async () => {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
    const out = await enhanceLocally(big);
    assert.deepEqual([out.width, out.height], [2048, 1024]);
});

test('enhancer: a cut-out is placed on white, a chosen colour, or kept transparent', async () => {
    const cutout = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer(), left: 5, top: 5 }])
        .png().toBuffer();
    const px = async (buf, x, y) => [...(await sharp(buf).raw().toBuffer({ resolveWithObject: true })).data.slice((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)];
    const white = await placeOnBackground(cutout);
    assert.equal(white.format, 'jpeg');
    assert.ok((await px(white.buffer, 1, 1)).every((v) => v > 245));
    assert.ok((await px(white.buffer, 10, 10))[2] > 200);
    const green = await placeOnBackground(cutout, '#00ff00');
    const g = await px(green.buffer, 1, 1);
    assert.ok(g[1] > 200 && g[0] < 60);
    const clear = await placeOnBackground(cutout, 'transparent');
    assert.equal(clear.format, 'png');
    assert.equal((await sharp(clear.buffer).metadata()).hasAlpha, true);
});

// ── The enhancer endpoint ───────────────────────────────────────────────────

/** Runs an Express handler and waits for it to answer (res.json) or fail (next). */
const call = (handler, req) => new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ sent: { code: this.code, body }, error: null }); return this; } };
    handler(req, res, (error) => resolve({ sent: null, error }));
});

const enhanceEnv = ({ tier = null, used = 0, atLimit = false } = {}) => {
    mock.method(Subscription, 'findOne', () => chain(tier ? { plan: tier } : null));
    mock.method(Setting, 'findOne', () => chain(null));
    const state = { used, consumed: 0, refunded: 0 };
    mock.method(EnhanceUsage, 'findOne', () => chain({ count: state.used }));
    mock.method(EnhanceUsage, 'findOneAndUpdate', async () => {
        if (atLimit) { const e = new Error('dup'); e.code = 11000; throw e; }
        state.used++; state.consumed++; return {};
    });
    mock.method(EnhanceUsage, 'updateOne', async () => { state.used--; state.refunded++; return {}; });
    return state;
};

test('enhance endpoint: returns the photo and counts one use', async () => {
    const state = enhanceEnv({ used: 1 });
    const { sent, error } = await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: await stripes(true) }, body: {} });
    assert.equal(error, null);
    assert.equal(sent.code, 200);
    assert.match(sent.body.data.image, /^data:image\/jpeg;base64,/);
    assert.equal(sent.body.data.mode, 'auto');
    assert.equal(state.consumed, 1);
    assert.deepEqual([sent.body.data.usage.used, sent.body.data.usage.limit, sent.body.data.usage.remaining], [2, 5, 3]);
});

test('enhance endpoint: the plan sets the monthly allowance', async () => {
    enhanceEnv({ tier: 'corporate' });
    const { sent } = await call(getEnhanceConfig, { user: { _id: 'u1' } });
    assert.equal(sent.body.data.usage.limit, 100);
    assert.equal(sent.body.data.modes.auto, true);
    assert.equal(sent.body.data.modes.removeBackground, false); // no Photoroom key here
});

test('enhance endpoint: past the monthly allowance it says so, and nothing is processed', async () => {
    const state = enhanceEnv({ used: 5, atLimit: true });
    const { sent, error } = await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: await stripes(true) }, body: {} });
    assert.equal(sent, null);
    assert.equal(error.statusCode, 429);
    assert.match(error.message, /all 5 enhancements/);
    assert.equal(state.refunded, 0);
});

test('enhance endpoint: a photo that cannot be read does not use up an enhancement', async () => {
    const state = enhanceEnv();
    const { error } = await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: Buffer.from('not an image') }, body: {} });
    assert.equal(error.statusCode, 422);
    assert.equal(state.consumed, 1);
    assert.equal(state.refunded, 1);
});

test('enhance endpoint: background removal is unavailable without a key, and costs nothing', async () => {
    delete process.env.PHOTOROOM_API_KEY;
    const state = enhanceEnv();
    const { error } = await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: await solid(10, 10, 10) }, body: { mode: 'remove_background' } });
    assert.equal(error.statusCode, 503);
    assert.equal(state.consumed, 0);
});

test('enhance endpoint: needs a photo and a known mode', async () => {
    enhanceEnv();
    assert.equal((await call(enhancePhoto, { user: { _id: 'u1' }, body: {} })).error.statusCode, 400);
    assert.equal((await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: await solid(1, 1, 1) }, body: { mode: 'cartoon' } })).error.statusCode, 400);
});

test('enhance endpoint: a plan with no allowance cannot use it', async () => {
    enhanceEnv();
    mock.method(Setting, 'findOne', (q) => chain(q.key === 'ENHANCE_LIMIT_FREE' ? { value: 0 } : null));
    clearSettingCache();
    const { error } = await call(enhancePhoto, { user: { _id: 'u1' }, file: { buffer: await solid(1, 1, 1) }, body: {} });
    assert.equal(error.statusCode, 429);
    assert.match(error.message, /not included/);
});
