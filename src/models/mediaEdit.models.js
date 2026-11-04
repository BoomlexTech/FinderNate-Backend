import mongoose from 'mongoose';

/**
 * One run of the video editor (Phase 5 #34, #62, #66, #49, #29): a person's
 * clips and choices go in, one finished MP4 comes out.
 *
 * The client uploads the clips, the server renders them in a background job
 * (src/queues/creatorQueue.js) and the client polls this document. The post or
 * story is then created with `editId`, which takes the finished video.
 *
 * The temp files live in `workDir` only while the job needs them.
 */
const MediaEditSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['reel', 'duet'], default: 'reel' },
    status: { type: String, enum: ['queued', 'processing', 'done', 'failed', 'expired'], default: 'queued' },
    // The sanitised edit list (see sanitizeEdl) and what each uploaded file contains.
    edl: { type: mongoose.Schema.Types.Mixed, required: true },
    probes: { type: mongoose.Schema.Types.Mixed, default: undefined },
    workDir: { type: String, default: '' },
    files: {
        type: new mongoose.Schema({
            clips: [String],
            overlays: [String],
        }, { _id: false }),
        default: undefined,
    },
    // For a duet: the video it answers.
    duet: {
        type: new mongoose.Schema({
            postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
            authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            authorUsername: String,
            layout: String,
        }, { _id: false }),
        default: undefined,
    },
    // Music that was mixed into the video, kept for the "♪" label on the post.
    music: {
        type: new mongoose.Schema({
            soundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sound' },
            startSec: Number,
            durationSec: Number,
            volume: Number,
        }, { _id: false }),
        default: undefined,
    },
    progress: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    // Shown to the person; the technical detail stays server-side.
    error: { type: String, default: '' },
    errorDetail: { type: String, default: '', select: false },
    result: {
        type: new mongoose.Schema({
            type: { type: String, default: 'video' },
            url: String,
            thumbnailUrl: String,
            coverUrl: String,
            duration: Number,
            width: Number,
            height: Number,
            fileSize: Number,
            format: String,
            processing: Boolean,
        }, { _id: false }),
        default: undefined,
    },
    usedByPostId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    usedByStoryId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    usedAt: { type: Date, default: null },
    cleanedAt: { type: Date, default: null },
    startedAt: Date,
    finishedAt: Date,
}, { timestamps: true });

MediaEditSchema.index({ userId: 1, createdAt: -1 });
MediaEditSchema.index({ status: 1, createdAt: 1 });
MediaEditSchema.index({ status: 1, usedAt: 1, finishedAt: 1 });

export default mongoose.model('MediaEdit', MediaEditSchema);
