import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import Story from "../../models/story.models.js";
import Reel from "../../models/reels.models.js";
import Like from "../../models/like.models.js";
import Comment from "../../models/comment.models.js";
import SavedPost from "../../models/savedPost.models.js";
import PostInteraction from "../../models/postInteraction.models.js";
import Report from "../../models/report.models.js";
import Order from "../../models/order.models.js";
import PaymentLink from "../../models/paymentLink.models.js";
import { deleteMultipleFromBunny, deleteFromBunny } from "../../utils/bunny.js";
import { invalidatePostCaches } from "./helpers.js";
import { cancelBoostsForPost } from "../../utils/boostServing.js";

/**
 * A post whose money is still in flight cannot be deleted.
 *
 * Deleting one used to be allowed at any time, and Order.postId was left
 * pointing at an id that no longer resolves. That is not just a blank product
 * card in the buyer's order history: the dispute path reads figures back off
 * the post, so a seller could change the outcome of a live money dispute by
 * deleting the listing underneath it.
 *
 * Only orders where the platform is actually holding the buyer's money block
 * the delete — 'paid' and 'held'. Once an order is released, refunded, failed
 * or still unpaid, nothing further is computed from the post and the listing
 * can go.
 */
const assertNoLiveOrders = async (postId) => {
    const liveOrder = await Order.exists({
        postId,
        paymentStatus: { $in: ['paid', 'held'] },
    });

    if (liveOrder) {
        throw new ApiError(
            409,
            "This post has an order with payment still in progress. It can't be deleted until that order is completed or refunded."
        );
    }
};

/**
 * A payment link cannot outlive the listing it sells.
 *
 * Deleting the post left every PaymentLink that referenced it sitting at status
 * 'active'. Nothing could actually be bought through one — the checkout
 * endpoints answer a deleted-content tombstone once the post is gone — but the
 * ROW still claimed to be live, so admin views and any query over open links
 * counted links for products that no longer exist.
 *
 * 'paid' rows are left exactly as they are: they are the record of a completed
 * sale, and the order created from one still points at it.
 */
const cancelPaymentLinksForPost = async (postId) =>
    PaymentLink.updateMany(
        { postId, status: 'active' },
        { $set: { status: 'cancelled' } }
    );

export const deletePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    const post = await Post.findById(id);
    if (!post) throw new ApiError(404, "Post not found");

    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own posts");
    }

    await assertNoLiveOrders(id);

    let bunnyDeletionResult = { totalDeleted: 0, errors: [] };

    const mediaUrls = [];
    if (post.media && post.media.length > 0) {
        post.media.forEach(media => {
            if (media.url) mediaUrls.push(media.url);
            if (media.thumbnailUrl) mediaUrls.push(media.thumbnailUrl);
            if (media.additionalMedia && media.additionalMedia.length > 0) {
                media.additionalMedia.forEach(additionalMedia => {
                    if (additionalMedia.url) mediaUrls.push(additionalMedia.url);
                    if (additionalMedia.thumbnailUrl) mediaUrls.push(additionalMedia.thumbnailUrl);
                });
            }
        });
    }

    if (mediaUrls.length > 0) {
        try {
            bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
        }
    }

    await Post.findByIdAndDelete(id);
    await Post.db.model('User').findByIdAndUpdate(userId, { $pull: { posts: id } });

    await Promise.allSettled([
        Like.deleteMany({ postId: id }),
        cancelPaymentLinksForPost(id),
        cancelBoostsForPost(id),
        // Comment.deleteMany({ postId: id }),
        // SavedPost.deleteMany({ postId: id })
    ]);

    const responseData = {
        postId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: bunnyDeletionResult.totalSkipped || 0,
            totalMediaFiles: mediaUrls.length,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Post deleted successfully, but some media files could not be removed from cloud storage"
                : "Post and all associated media deleted successfully"
        )
    );
});

export const deleteStory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    const story = await Story.findById(id);
    if (!story) throw new ApiError(404, "Story not found");

    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own stories");
    }

    let bunnyDeletionResult = { totalDeleted: 0, errors: [] };

    if (story.mediaUrl) {
        try {
            await deleteFromBunny(story.mediaUrl);
            bunnyDeletionResult.totalDeleted = 1;
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
        }
    }

    await Story.findByIdAndDelete(id);

    const responseData = {
        storyId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: 0,
            totalMediaFiles: story.mediaUrl ? 1 : 0,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Story deleted successfully, but media file could not be removed from cloud storage"
                : "Story and associated media deleted successfully"
        )
    );
});

export const deleteReel = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    const reel = await Reel.findById(id);
    if (!reel) throw new ApiError(404, "Reel not found");

    if (reel.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only delete your own reels");
    }

    let bunnyDeletionResult = { totalDeleted: 0, errors: [] };

    const mediaUrls = [];
    if (reel.videoUrl) mediaUrls.push(reel.videoUrl);
    if (reel.thumbnailUrl) mediaUrls.push(reel.thumbnailUrl);

    if (mediaUrls.length > 0) {
        try {
            bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
            bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
        }
    }

    await Reel.findByIdAndDelete(id);

    await Promise.allSettled([
        Like.deleteMany({ postId: id }),
        // Comment.deleteMany({ reelId: id }),
    ]);

    const responseData = {
        reelId: id,
        mediaCleanup: {
            filesDeleted: bunnyDeletionResult.totalDeleted,
            filesSkipped: bunnyDeletionResult.totalSkipped || 0,
            totalMediaFiles: mediaUrls.length,
            errors: bunnyDeletionResult.errors
        }
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            responseData,
            bunnyDeletionResult.errors.length > 0
                ? "Reel deleted successfully, but some media files could not be removed from cloud storage"
                : "Reel and all associated media deleted successfully"
        )
    );
});

export const deleteContent = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    let content = null;
    let contentType = null;
    let mediaUrls = [];
    let bunnyDeletionResult = { totalDeleted: 0, totalSkipped: 0, errors: [] };

    try {
        // 1. Try Post collection first
        content = await Post.findById(postId);
        if (content) {
            contentType = 'post';

            if (content.userId.toString() !== userId.toString()) {
                throw new ApiError(403, "You can only delete your own posts");
            }

            await assertNoLiveOrders(postId);

            if (content.media && content.media.length > 0) {
                content.media.forEach(media => {
                    if (media.url) mediaUrls.push(media.url);
                    if (media.thumbnailUrl) mediaUrls.push(media.thumbnailUrl);
                    if (media.additionalMedia && media.additionalMedia.length > 0) {
                        media.additionalMedia.forEach(additionalMedia => {
                            if (additionalMedia.url) mediaUrls.push(additionalMedia.url);
                            if (additionalMedia.thumbnailUrl) mediaUrls.push(additionalMedia.thumbnailUrl);
                        });
                    }
                });
            }

            // Database row FIRST, then the media.
            //
            // The order used to be the other way round, and it is only
            // recoverable in one direction. Deleting Bunny first and then
            // failing on the database leaves a live post pointing at files that
            // no longer exist — broken images in everyone's feed, permanently.
            // Doing the row first and failing on Bunny leaves orphaned files:
            // invisible, costing a little storage, and cleanable later.
            await Post.findByIdAndDelete(postId);
            await Post.db.model('User').findByIdAndUpdate(userId, { $pull: { posts: postId } });

            if (mediaUrls.length > 0) {
                try {
                    bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
                } catch (error) {
                    console.error("Bunny.net deletion error:", error);
                    bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
                }
            }

            // Everything that points AT the post. PostInteraction, Report,
            // PaymentLink and Order were left dangling — rows referencing an id
            // that no longer resolves, which then render as blank cards and
            // skew the counts built from them.
            await Promise.allSettled([
                Like.deleteMany({ postId: postId }),
                Comment.deleteMany({ postId: postId }),
                SavedPost.deleteMany({ postId: postId }),
                PostInteraction.deleteMany({ postId: postId }),
                Report.deleteMany({ reportedPostId: postId }),
                cancelPaymentLinksForPost(postId),
                cancelBoostsForPost(postId),
            ]);

            await invalidatePostCaches(postId, userId);
        }

        // 2. Try Story collection
        if (!content) {
            content = await Story.findById(postId);
            if (content) {
                contentType = 'story';

                if (content.userId.toString() !== userId.toString()) {
                    throw new ApiError(403, "You can only delete your own stories");
                }

                if (content.mediaUrl) {
                    mediaUrls.push(content.mediaUrl);
                }

                if (mediaUrls.length > 0) {
                    try {
                        const result = await deleteFromBunny(content.mediaUrl);
                        bunnyDeletionResult.totalDeleted = 1;
                    } catch (error) {
                        console.error("Bunny.net deletion error:", error);
                        bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
                    }
                }

                await Story.findByIdAndDelete(postId);
                await invalidatePostCaches(postId, userId);
            }
        }

        // 3. Try Reel collection
        if (!content) {
            content = await Reel.findById(postId);
            if (content) {
                contentType = 'reel';

                if (content.userId.toString() !== userId.toString()) {
                    throw new ApiError(403, "You can only delete your own reels");
                }

                if (content.videoUrl) mediaUrls.push(content.videoUrl);
                if (content.thumbnailUrl) mediaUrls.push(content.thumbnailUrl);

                if (mediaUrls.length > 0) {
                    try {
                        bunnyDeletionResult = await deleteMultipleFromBunny(mediaUrls);
                    } catch (error) {
                        console.error("Bunny.net deletion error:", error);
                        bunnyDeletionResult.errors.push({ error: `Bunny.net deletion failed: ${error.message}` });
                    }
                }

                await Reel.findByIdAndDelete(postId);

                await Promise.allSettled([
                    Like.deleteMany({ postId: postId }),
                    Comment.deleteMany({ postId: postId }),
                    SavedPost.deleteMany({ postId: postId })
                ]);

                await invalidatePostCaches(postId, userId);
            }
        }

        // 4. Not found in any collection
        if (!content) {
            throw new ApiError(404, "Content not found. The post, story, or reel may have already been deleted.");
        }

        const responseData = {
            postId,
            contentType,
            mediaCleanup: {
                filesDeleted: bunnyDeletionResult.totalDeleted,
                filesSkipped: bunnyDeletionResult.totalSkipped || 0,
                totalMediaFiles: mediaUrls.length,
                errors: bunnyDeletionResult.errors
            }
        };

        return res.status(200).json(
            new ApiResponse(
                200,
                responseData,
                bunnyDeletionResult.errors.length > 0
                    ? `${contentType.charAt(0).toUpperCase() + contentType.slice(1)} deleted successfully, but some media files could not be removed from cloud storage`
                    : `${contentType.charAt(0).toUpperCase() + contentType.slice(1)} and all associated media deleted successfully`
            )
        );
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, `Error deleting content: ${error.message}`);
    }
});
