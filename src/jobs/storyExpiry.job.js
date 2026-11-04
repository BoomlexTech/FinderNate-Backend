import cron from 'node-cron';
import Story from '../models/story.models.js';
import { deleteFromBunny } from '../utils/bunny.js';
import StoryComment from '../models/storyComment.models.js';
import StickerResponse from '../models/stickerResponse.models.js';
import { clearStickerResponses } from '../controllers/storyStickers.controllers.js';

/** Liked or commented on, so worth keeping in the archive (Phase 2 #32). */
export const hasStoryEngagement = async (story) => {
    if ((story.likedBy?.length || 0) > 0 || (story.commentsCount || 0) > 0) return true;
    // commentsCount is maintained by the comment endpoints; the row check
    // covers a counter that drifted.
    if (await StoryComment.exists({ storyId: story._id })) return true;
    // Phase 5 #47: poll votes, quiz answers, slider values and questions are
    // results the owner wants to read. A countdown reminder alone is not.
    return !!(await StickerResponse.exists({ storyId: story._id, stickerType: { $ne: 'countdown' } }));
};

/**
 * Story Expiry Cron Job
 * Runs every 15 minutes and removes stories that are more than 24 hours old.
 *
 * A story has to be gone 24 hours after it was posted — the database row AND
 * the media file behind it. A Mongo TTL index only does the first half: it
 * drops the document and leaves the image or video sitting in the Bunny
 * storage zone (or the Stream library) forever, still billable and still
 * reachable by anyone who kept the URL. That is why the TTL index was taken
 * off story.models.js and replaced by this job.
 *
 * Order matters: media first, row second. If Bunny fails we keep the row, log
 * it, and let a later pass try again — a row is recoverable, an orphaned file
 * nobody has a reference to is not.
 *
 * Safe to run on several instances at once: each row is claimed atomically
 * with findOneAndUpdate before its media is touched, so no file is deleted
 * twice and no two workers race on the same story. Claims older than
 * CLAIM_TTL_MS are treated as abandoned (a worker that died mid-pass, or a
 * media delete that failed) and are picked up again.
 */

// A story lives for 24 hours. uploadStory writes expiresAt = createdAt + 24h
// and the schema marks it required, so in practice every row has it; this
// constant is the fallback for any legacy row written before that, whose age
// has to be derived from createdAt instead.
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

// How many expired rows one pass pulls into memory at a time. The backlog can
// be arbitrarily large — nothing has ever swept this collection — so it is
// walked in batches rather than loaded whole.
const BATCH_SIZE = 100;

// Ceiling on batches per run, so one pass cannot run for hours against a huge
// backlog. Whatever is left is picked up by the next tick.
const MAX_BATCHES_PER_RUN = 50;

// How long a claim is honoured before another worker may re-take the row.
// Also acts as the retry backoff for a story whose media delete failed.
const CLAIM_TTL_MS = 15 * 60 * 1000;

// Guards against one instance's ticks overlapping if a pass runs long.
let isRunning = false;

/**
 * Delete every story past its 24-hour life, media first.
 * Returns a summary; never throws.
 */
export const purgeExpiredStories = async ({
    batchSize = BATCH_SIZE,
    maxBatches = MAX_BATCHES_PER_RUN,
} = {}) => {
    const now = new Date();
    const legacyCutoff = new Date(now.getTime() - STORY_LIFETIME_MS);
    const claimCutoff = new Date(now.getTime() - CLAIM_TTL_MS);

    // Not currently claimed by another worker (or claimed so long ago the
    // claim is abandoned). Reused as the guard on the atomic claim below.
    const claimable = [
        { purgeClaimedAt: null },
        { purgeClaimedAt: { $lte: claimCutoff } },
    ];

    const expiredFilter = {
        // Archived stories are a deliberate keep and are read long after
        // expiresAt has passed — see the note in story.models.js.
        isArchived: false,
        $and: [
            { $or: claimable },
            {
                $or: [
                    { expiresAt: { $lte: now } },
                    // Legacy rows written without expiresAt: age them off
                    // createdAt so the backlog is covered too. `null` matches
                    // both an explicit null and a missing field.
                    { expiresAt: null, createdAt: { $lte: legacyCutoff } },
                ],
            },
        ],
    };

    let deleted = 0;
    let archived = 0;
    let mediaFailed = 0;
    let claimedElsewhere = 0;
    let batches = 0;

    try {
        while (batches < maxBatches) {
            batches++;

            const candidates = await Story.find(expiredFilter)
                .select('_id mediaUrl commentsCount likedBy')
                .sort({ expiresAt: 1 })
                .limit(batchSize)
                .lean();

            if (candidates.length === 0) break;

            for (const candidate of candidates) {
                // A story people liked or commented on is kept: it moves to
                // the owner's archive with its likes, comments and viewers
                // instead of being deleted (Phase 2 #32). Only the owner can
                // see it there.
                if (await hasStoryEngagement(candidate)) {
                    const kept = await Story.updateOne(
                        { _id: candidate._id, isArchived: false, $or: claimable },
                        { $set: { isArchived: true, autoArchivedAt: new Date() } }
                    );
                    if (kept.modifiedCount) archived++;
                    continue;
                }

                // Atomic claim. If another worker got here first this returns
                // null and we simply move on — no double delete, no error.
                const claimed = await Story.findOneAndUpdate(
                    { _id: candidate._id, $or: claimable },
                    { $set: { purgeClaimedAt: new Date() } },
                    { new: true, projection: { mediaUrl: 1, 'sharedPost.postId': 1 } }
                ).lean();

                if (!claimed) {
                    claimedElsewhere++;
                    continue;
                }

                // Media first. deleteFromBunny handles both storage-zone files
                // and Stream videos, and treats a 404 as success, so a retry
                // of a partially-done row is harmless.
                // A repost (Phase 2 #56) shows the ORIGINAL post's media and
                // owns no file of its own: deleting mediaUrl would delete the
                // original post's photo or video.
                if (claimed.mediaUrl && !claimed.sharedPost?.postId) {
                    try {
                        await deleteFromBunny(claimed.mediaUrl);
                    } catch (error) {
                        mediaFailed++;
                        // Keep the row. It is the only remaining reference to
                        // the file; deleting it now would orphan the media
                        // permanently. The claim expires in CLAIM_TTL_MS and a
                        // later pass retries this story.
                        console.error(
                            `⚠️ [StoryExpiry] Media delete failed for story ${candidate._id} — row kept for the next pass:`,
                            error.message
                        );
                        continue;
                    }
                }

                await Story.deleteOne({ _id: candidate._id });
                clearStickerResponses(candidate._id);
                deleted++;
            }

            // A short batch means the backlog is drained.
            if (candidates.length < batchSize) break;
        }

        if (deleted > 0 || archived > 0 || mediaFailed > 0) {
            console.log(
                `🧹 [StoryExpiry] Purged ${deleted} expired stories, archived ${archived} with likes or comments (${mediaFailed} kept after media-delete failure, ${claimedElsewhere} handled by another worker)`
            );
        }

        return { success: true, deleted, archived, mediaFailed, claimedElsewhere, batches };
    } catch (error) {
        console.error('❌ [StoryExpiry] Story expiry job failed:', error);
        return { success: false, deleted, mediaFailed, claimedElsewhere, batches, error: error.message };
    }
};

/**
 * Start the cron job
 * Schedule: every 15 minutes
 */
export const startStoryExpiryJob = () => {
    const purgeJob = cron.schedule('*/15 * * * *', async () => {
        if (isRunning) {
            console.log('⏭️ [Cron] Story expiry job still running — skipping this tick');
            return;
        }
        isRunning = true;
        try {
            console.log('⏰ [Cron] Story expiry job triggered');
            await purgeExpiredStories();
        } finally {
            isRunning = false;
        }
    }, {
        scheduled: true,
        timezone: 'Asia/Kolkata'
    });

    console.log('✅ [Cron] Story expiry job scheduled (every 15 minutes)');

    return purgeJob;
};

// For testing purposes - run immediately
export const runStoryPurgeNow = async () => {
    return await purgeExpiredStories();
};
