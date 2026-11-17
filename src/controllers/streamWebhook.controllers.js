import Post from "../models/userPost.models.js";
import MediaEdit from "../models/mediaEdit.models.js";
import { settleEncodingEdit } from "../services/mediaRender.service.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
    isStreamEnabled,
    getStreamVideo,
    bestAvailableRendition,
    streamVideoUrl,
} from "../utils/bunny.js";
import { invalidatePostCaches } from "./post/helpers.js";

/**
 * Bunny Stream encoding webhook.
 *
 * Upload returns a GUID and a playable-looking URL immediately, but the
 * renditions take roughly 10-30s for a short clip. Media is written with
 * `processing: true` and this clears it, so the feeds can show the thumbnail
 * rather than a player that fails.
 *
 * Bunny POSTs { VideoLibraryId, VideoGuid, Status }. The statuses that matter:
 *   4 = Finished        -> playable, clear the flag
 *   5 = Error
 *   6 = UploadFailed    -> it will never play; clear it anyway so the client
 *                          stops waiting and shows its normal error state
 *                          instead of a spinner that never resolves.
 *
 * Bunny does not sign these, so the payload is treated as untrusted: the only
 * thing acted on is "a video with this GUID finished", and the GUID has to
 * already be stored against a post. An attacker who guesses one can at worst
 * clear a flag that was about to clear itself.
 */
export const handleStreamWebhook = asyncHandler(async (req, res) => {
    // Always 200. A webhook that errors gets retried, and there is nothing
    // here worth retrying — the next status change will arrive regardless.
    const respond = (note) =>
        res.status(200).json(new ApiResponse(200, { note }, "ok"));

    if (!isStreamEnabled()) return respond("stream not configured");

    const guid = req.body?.VideoGuid;
    const status = Number(req.body?.Status);
    if (!guid) return respond("no VideoGuid");

    const FINISHED = 4, ERROR = 5, UPLOAD_FAILED = 6;
    if (![FINISHED, ERROR, UPLOAD_FAILED].includes(status)) {
        return respond(`status ${status} ignored`);
    }

    // The GUID is the first path segment of the stored URL, so an anchored
    // match on "/<guid>/" cannot collide with another video's id appearing
    // elsewhere in the string. Escaped because a GUID from an untrusted body
    // would otherwise be interpreted as a regex.
    const safeGuid = String(guid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = { "media.url": { $regex: `/${safeGuid}/` } };

    // Ids are needed for cache invalidation — invalidatePostCaches keys several
    // entries off the post id, so it cannot be called without one.
    // An editor result (vibe edit or duet) waiting for this video: finish it,
    // so the editor's preview can play it.
    const waitingEdits = await MediaEdit.find({
        status: 'processing',
        encodingSince: { $exists: true },
        'result.url': { $regex: `/${safeGuid}/` },
    }).lean();
    for (const edit of waitingEdits) {
        await settleEncodingEdit(edit, { force: true }).catch(() => {});
    }

    const affected = await Post.find(match).select('_id userId').lean();
    if (affected.length === 0) return respond(waitingEdits.length ? `settled ${waitingEdits.length} edit(s)` : 'no matching post');

    // Upload stored the 720p URL, but Bunny never upscales — a 360p source
    // only ever produces a 360p MP4, and that stored URL would 404 forever.
    // Encoding is finished now, so this is the first point the real ladder is
    // known. Correct the URL and record the ladder for the clients.
    const set = { "media.$[item].processing": false };
    if (status === FINISHED) {
        try {
            const video = await getStreamVideo(guid);
            const resolutions = video?.availableResolutions || '';
            const best = bestAvailableRendition(resolutions);
            if (best) {
                set["media.$[item].url"] = streamVideoUrl(guid, best);
                set["media.$[item].availableResolutions"] = resolutions;
            }
            // Bunny reports length in seconds once encoding finishes. This is
            // the only reliable source for it — the upload call returns before
            // anything has been probed — and Vibes eligibility is decided on
            // it, so a video with no duration would otherwise be judged by a
            // field nothing ever set.
            if (Number.isFinite(video?.length) && video.length > 0) {
                set["media.$[item].duration"] = video.length;
            }
        } catch {
            // Leave the stored URL alone rather than guessing. Worst case it
            // is the 720p one, which is right for any normal phone recording.
        }
    }

    const result = await Post.updateMany(
        match,
        { $set: set },
        { arrayFilters: [{ "item.url": { $regex: `/${safeGuid}/` } }] }
    );

    // The feeds cache post documents; without this the media stays
    // "processing" for viewers until the cache expires on its own.
    await Promise.allSettled(
        affected.map((p) => invalidatePostCaches(p._id.toString(), p.userId?.toString()))
    );

    return respond(`cleared ${result.modifiedCount}`);
});
