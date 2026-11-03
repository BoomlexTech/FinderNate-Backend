import { ApiError } from "./ApiError.js";

/**
 * Per-post interaction switches (Phase 2 #18).
 *
 * settings.allowLikes / allowComments / allowShares are Booleans with no
 * default, so every post created before the switches existed has them
 * undefined. Only an explicit `false` turns something off; undefined and true
 * both mean "allowed". The author is never blocked by their own switches.
 */
const INTERACTIONS = Object.freeze({
    like: { field: 'allowLikes', message: 'Likes are turned off for this post' },
    comment: { field: 'allowComments', message: 'Comments are turned off for this post' },
    share: { field: 'allowShares', message: 'Sharing is turned off for this post' },
});

export const isPostInteractionAllowed = (post, viewerId, kind) => {
    const rule = INTERACTIONS[kind];
    if (!rule || !post) return true;
    const authorId = post.userId?._id ?? post.userId;
    if (viewerId && authorId && authorId.toString() === viewerId.toString()) return true;
    return post.settings?.[rule.field] !== false;
};

/** Throws 403 INTERACTION_DISABLED when the post's author has switched `kind` off. */
export const assertPostInteractionAllowed = (post, viewerId, kind) => {
    if (isPostInteractionAllowed(post, viewerId, kind)) return;
    throw new ApiError(403, INTERACTIONS[kind].message, [{ code: 'INTERACTION_DISABLED', interaction: kind }]);
};

/** The three switches as booleans, for responses (undefined reads as allowed). */
export const interactionSettingsOf = (post) => ({
    allowLikes: post?.settings?.allowLikes !== false,
    allowComments: post?.settings?.allowComments !== false,
    allowShares: post?.settings?.allowShares !== false,
});
