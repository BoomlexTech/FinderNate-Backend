import { Queue, Worker } from 'bullmq';

/**
 * Background work for the creator tools (Phase 5): rendering edits (reel
 * editor, music mixing, duets) and pulling the sound out of new vibes.
 *
 * FFmpeg is heavy, so it runs one job at a time per worker
 * (EDIT_WORKER_CONCURRENCY). With several app instances only the first runs
 * the worker unless EDIT_WORKER_ALL_INSTANCES=true; EDIT_WORKER_ENABLED=false
 * turns the worker off on an instance that should only take requests.
 */

const connection = () => ({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
});

export const QUEUE_NAME = 'creator-media';

let queue = null;
const getQueue = () => {
    if (!queue) {
        queue = new Queue(QUEUE_NAME, {
            connection: connection(),
            defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500 },
        });
        queue.on('error', (e) => console.error('[creatorQueue]', e?.message || e));
    }
    return queue;
};

export const enqueueEdit = (editId) =>
    getQueue().add('edit', { editId: String(editId) }, {
        jobId: `edit-${editId}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
    });

/** Wait a little first: a Stream video is not downloadable until it has been encoded. */
export const enqueueOriginalAudio = (postId) =>
    getQueue().add('original-audio', { postId: String(postId) }, {
        jobId: `original-audio-${postId}`,
        delay: 20 * 1000,
        attempts: 6,
        backoff: { type: 'exponential', delay: 30 * 1000 },
    });

let worker = null;

export const startCreatorWorker = async () => {
    if (worker) return worker;
    if (process.env.EDIT_WORKER_ENABLED === 'false') return null;
    if ((process.env.NODE_APP_INSTANCE ?? '0') !== '0' && process.env.EDIT_WORKER_ALL_INSTANCES !== 'true') return null;

    // Loaded here so importing this file (for enqueueEdit) stays light.
    const [{ runEdit }, { extractOriginalAudio }, { isFfmpegAvailable }] = await Promise.all([
        import('../services/mediaRender.service.js'),
        import('../services/sounds.service.js'),
        import('../services/ffmpeg.service.js'),
    ]);
    if (!(await isFfmpegAvailable())) {
        console.warn('⚠️ [creator] FFmpeg was not found: the video editor, music mixing and duets are switched off. Install ffmpeg or set FFMPEG_PATH.');
        return null;
    }

    worker = new Worker(QUEUE_NAME, async (job) => {
        if (job.name === 'edit') return runEdit(job.data.editId);
        if (job.name === 'original-audio') return extractOriginalAudio(job.data.postId);
        return null;
    }, {
        connection: connection(),
        concurrency: Math.max(1, Number(process.env.EDIT_WORKER_CONCURRENCY) || 1),
    });
    worker.on('failed', (job, err) => console.error(`[creator] ${job?.name} ${job?.id} failed:`, err?.message));
    worker.on('error', (err) => console.error('[creator] worker error:', err?.message || err));
    console.log('🎬 [creator] worker started');
    return worker;
};
