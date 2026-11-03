import mongoose from 'mongoose';
import PostInteraction from '../models/postInteraction.models.js';

/**
 * "Seen" and "fresh" flags on listings (Phase 2 #33).
 *
 *   isSeen  - the viewer has opened this post before (a 'view' interaction,
 *             kept for 90 days)
 *   isFresh - not seen, and posted in the last 48 hours
 *
 * Per viewer, so never cached with a page. Mutates and returns `posts`.
 */
export const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;

const idOf = (post) => post?._id ?? post?.id ?? post?.postId;

export const seenFlagsFor = (post, seenIds, now = Date.now()) => {
    const isSeen = seenIds.has(String(idOf(post)));
    const created = post.createdAt ? new Date(post.createdAt).getTime() : 0;
    return { isSeen, isFresh: !isSeen && created > 0 && now - created <= FRESH_WINDOW_MS };
};

export const annotateSeen = async (posts, viewerId) => {
    if (!Array.isArray(posts) || posts.length === 0) return posts;
    let seenIds = new Set();
    if (viewerId) {
        try {
            const ids = posts.map(idOf).filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));
            const rows = await PostInteraction.find({
                userId: viewerId,
                postId: { $in: ids },
                interactionType: 'view',
            }).select('postId').lean();
            seenIds = new Set(rows.map((r) => String(r.postId)));
        } catch { /* flags are a nicety; never fail the page */ }
    }
    const now = Date.now();
    for (const post of posts) {
        if (!post) continue;
        Object.assign(post, seenFlagsFor(post, seenIds, now));
    }
    return posts;
};
