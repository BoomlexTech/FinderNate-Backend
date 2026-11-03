/**
 * Story likes and comments on story payloads (Phase 2 #32). Pure.
 *
 * `likedBy` never leaves the server (like `viewers`). Everyone gets
 * likesCount and whether they liked it themselves; only the owner gets
 * commentsCount, since comments are visible to the owner alone.
 */
export const shapeStoryEngagement = (obj, viewerId, isOwner) => {
    if (!obj) return obj;
    const likedBy = Array.isArray(obj.likedBy) ? obj.likedBy : [];
    obj.likesCount = likedBy.length;
    obj.isLiked = !!viewerId && likedBy.some((id) => String(id?._id ?? id) === String(viewerId));
    if (isOwner) {
        obj.commentsCount = obj.commentsCount || 0;
    } else {
        delete obj.commentsCount;
        delete obj.autoArchivedAt;
    }
    delete obj.likedBy;
    return obj;
};

/** Whether others can still like or comment: live, not archived. Pure. */
export const isStoryLive = (story, now = new Date()) =>
    !!story && story.isArchived !== true && !!story.expiresAt && new Date(story.expiresAt) > now;

export const MAX_STORY_COMMENT_LENGTH = 500;
