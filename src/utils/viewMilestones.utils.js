import mongoose from 'mongoose';
import Post from '../models/userPost.models.js';
import { notifyActivity } from './activityNotify.utils.js';
import { getSettingValue } from './appSettings.utils.js';

/**
 * Unique views and listing view milestones (Phase 2 #46).
 *
 * A view counts once per viewer per post (the first 'view' interaction row),
 * never for the author. When a listing (product, service or business post)
 * passes 50, 100 or 500 views (admin setting VIEW_MILESTONES), its owner is
 * told once per threshold, with a link to boost it.
 */
export const DEFAULT_VIEW_MILESTONES = [50, 100, 500];
const LISTING_TYPES = ['product', 'service', 'business'];

/** Thresholds reached by `views` that haven't been announced yet. Pure. */
export const milestonesToAnnounce = (views, thresholds, alreadyAnnounced = []) => {
    const done = new Set((alreadyAnnounced || []).map(Number));
    return [...new Set((thresholds || []).map(Number))]
        .filter((t) => Number.isFinite(t) && t > 0 && views >= t && !done.has(t))
        .sort((a, b) => a - b);
};

export const milestoneMessage = (threshold) =>
    `Your listing reached ${threshold} views. It's gaining attention, consider boosting it`;

/**
 * Count first-time views by `viewerId` of `postIds` (the author's own views
 * are skipped) and announce any milestone they cross. Best-effort.
 */
export const recordUniqueViews = async (postIds, viewerId) => {
    const ids = [...new Set((postIds || []).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return;
    try {
        await Post.updateMany(
            { _id: { $in: ids }, userId: { $ne: viewerId } },
            { $inc: { 'engagement.views': 1 } },
        );
        const listings = await Post.find({ _id: { $in: ids }, userId: { $ne: viewerId }, contentType: { $in: LISTING_TYPES } })
            .select('userId engagement.views +viewMilestones').lean();
        if (!listings.length) return;
        const thresholds = await getSettingValue('VIEW_MILESTONES', DEFAULT_VIEW_MILESTONES);
        for (const post of listings) {
            const due = milestonesToAnnounce(post.engagement?.views || 0, thresholds, post.viewMilestones);
            for (const threshold of due) {
                // Claimed atomically so two servers never announce the same one.
                const claimed = await Post.updateOne(
                    { _id: post._id, viewMilestones: { $ne: threshold } },
                    { $addToSet: { viewMilestones: threshold } },
                );
                if (!claimed.modifiedCount) continue;
                await notifyActivity({
                    recipientId: post.userId,
                    type: 'milestone',
                    message: milestoneMessage(threshold),
                    postId: post._id,
                    data: { views: threshold },
                    push: { title: `${threshold} views on your listing`, url: `/boosts?postId=${post._id}` },
                });
            }
        }
    } catch (err) {
        console.warn('[views] unique view / milestone update failed:', err?.message);
    }
};
