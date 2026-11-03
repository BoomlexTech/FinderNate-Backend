import mongoose from 'mongoose';

const StorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    mediaUrl: {
        type: String,
        required: true
    },
    mediaType: {
        type: String,
        enum: ['image', 'video'],
        default: 'image'
    },
    caption: {
        type: String,
        trim: true
    },
    viewers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    // Phase 2 #32: who liked the story. Like `viewers`, it never leaves the
    // server; responses carry likesCount / isLiked instead.
    likedBy: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        default: undefined
    },
    commentsCount: { type: Number, default: 0 },
    // Phase 2 #56: a story that reposts a post or vibe. mediaUrl then points
    // at the ORIGINAL post's media, which this story does not own: the purge
    // job and deleteStory must never delete it from the CDN.
    sharedPost: {
        type: new mongoose.Schema({
            postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
            authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            authorUsername: String,
            authorFullName: String,
            authorProfileImageUrl: String,
            postType: String,
            contentType: String,
            isVibe: Boolean,
            caption: String,
            mediaType: String,
            thumbnailUrl: String,
            title: String,
            price: Number,
            currency: String
        }, { _id: false }),
        default: undefined
    },
    // Set only by the author, through PATCH /stories/:storyId/archive (and
    // cleared by .../unarchive). An archived story is exempt from the 24-hour
    // purge job, is hidden from the live tray and the profile stories tab, and
    // is what fetchArchivedStoriesByUser lists.
    isArchived: {
        type: Boolean,
        default: false
    },
    expiresAt: {
        type: Date,
        required: true
    },
    // Bookkeeping for the story-expiry job: set when a worker takes ownership
    // of a row it is about to purge. Two workers therefore never try to delete
    // the same media file, and a row whose media delete failed is left alone
    // until the claim goes stale instead of being retried in a tight loop. It
    // is never read by any API path, so it stays out of responses.
    purgeClaimedAt: {
        type: Date,
        default: null,
        select: false
    }
}, { timestamps: true });

// Stories are purged 24 hours after they are posted — the row AND the media
// file — by the story-expiry job (src/jobs/storyExpiry.job.js). NOT by a
// MongoDB TTL index.
//
// A TTL index (expiresAt, expireAfterSeconds: 0) used to live here and was
// removed deliberately. The TTL monitor drops the document and knows nothing
// about Bunny: every expiry left the image or video live on the CDN forever,
// so the row vanished but the storage bill did not — deletion that is only
// cosmetic. The job does it in the safe order instead, media first and the row
// only once that succeeded, so a Bunny failure leaves the row for the next
// pass rather than orphaning the file.
//
// DEPLOY NOTE: the old TTL index still exists on the live collection and
// Mongoose will not alter an existing index's expireAfterSeconds. It has to be
// dropped by hand — db.stories.dropIndex('expiresAt_1') — otherwise Mongo keeps
// racing the job and orphaning media exactly as before.
//
// Archived stories stay exempt, as they were under the TTL's partial filter:
// fetchArchivedStoriesByUser reads { userId, isArchived: true } long after
// expiresAt has gone by, so the job only ever considers isArchived: false.

// Serves the purge job's scan ({ isArchived: false, expiresAt <= now, not
// currently claimed }) and, on its { isArchived, expiresAt } prefix, the
// stories tray (fetchStoriesFeed) and the profile stories tab, which both
// filter { isArchived: false, expiresAt: { $gt: now } }.
StorySchema.index({ isArchived: 1, expiresAt: 1, purgeClaimedAt: 1 });

// Archive screen and per-user story lookups: { userId, isArchived } sorted by
// createdAt desc.
StorySchema.index({ userId: 1, isArchived: 1, createdAt: -1 });

export default mongoose.model('Story', StorySchema);
