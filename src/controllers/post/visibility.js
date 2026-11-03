import mongoose from "mongoose";
import Post from "../../models/userPost.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { checkContentVisibility } from "../../middlewares/privacy.middleware.js";

/**
 * "May this viewer touch this post at all?"
 *
 * getPostById enforces the whole chain — block in either direction, the
 * author's account privacy, the post's own privacy flag — but every OTHER
 * endpoint hanging off the same post (comments, likes, saves) enforced
 * nothing, so asking for a post's comments or liking it was a way around the
 * gate the post read path defends.
 *
 * checkContentVisibility is the platform's existing gate and already covers
 * blocking (both directions), deactivated/banned/deleted authors, and account
 * privacy including the isFullPrivate flag. The only thing it does not know
 * about is the POST-level privacy flag, which is a separate field, so that is
 * checked here on top.
 *
 * 404 rather than 403 for a block or a hidden account: whether a given post
 * exists is itself information the blocked party should not get, and it is how
 * getPostById answers the same situation.
 *
 * @param {string} postId
 * @param {string|import('mongoose').Types.ObjectId|null} viewerId  null for anonymous callers
 * @param {{ notFoundMessage?: string }} [options]
 * @returns {Promise<Object>} the post document ({ _id, userId, settings.privacy })
 */
export const assertCanViewPostById = async (postId, viewerId, options = {}) => {
    const notFoundMessage = options.notFoundMessage || "Post not found";

    // A malformed id is a 404, not the 500 a CastError would produce.
    if (!postId || !mongoose.Types.ObjectId.isValid(postId)) {
        throw new ApiError(404, notFoundMessage);
    }

    // The interaction switches ride along so callers that go on to like,
    // comment or share can check them without a second read (#18).
    const post = await Post.findById(postId)
        .select("userId postType contentType category hashtags pinnedCommentId settings.privacy settings.allowLikes settings.allowComments settings.allowShares")
        .lean();
    if (!post) throw new ApiError(404, notFoundMessage);

    const authorId = post.userId?._id ?? post.userId;
    if (!authorId) throw new ApiError(404, notFoundMessage);

    // The author always sees their own post, whatever it is set to.
    if (viewerId && authorId.toString() === viewerId.toString()) return post;

    const visible = await checkContentVisibility(viewerId || null, authorId);
    if (!visible) throw new ApiError(404, notFoundMessage);

    if (post.settings?.privacy === "private") {
        throw new ApiError(403, "You don't have permission to view this post");
    }

    return post;
};

/**
 * Non-throwing form, for list endpoints that filter rather than reject.
 *
 * Returns a predicate over already-loaded post documents (which must carry
 * `userId` and `settings.privacy`). The account-level answer is memoised per
 * author for the lifetime of the returned checker, so a page of twenty saved
 * posts by the same three people costs three lookups, not twenty.
 */
export const createPostVisibilityChecker = (viewerId) => {
    const byAuthor = new Map();
    const viewerIdStr = viewerId ? viewerId.toString() : null;

    return async (post) => {
        if (!post) return false;

        const authorId = post.userId?._id ?? post.userId;
        if (!authorId) return false;

        const authorIdStr = authorId.toString();
        if (viewerIdStr && authorIdStr === viewerIdStr) return true;

        if (post.settings?.privacy === "private") return false;

        if (!byAuthor.has(authorIdStr)) {
            byAuthor.set(authorIdStr, checkContentVisibility(viewerId || null, authorId));
        }
        return await byAuthor.get(authorIdStr);
    };
};

// Per-post like/comment/share switches (#18) live in a dependency-free module
// so they can be unit tested.
export { isPostInteractionAllowed, assertPostInteractionAllowed, interactionSettingsOf } from '../../utils/postInteraction.utils.js';
