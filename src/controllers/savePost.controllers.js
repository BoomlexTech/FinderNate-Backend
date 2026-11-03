import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import SavedPost from '../models/savedPost.models.js';
import { User } from '../models/user.models.js';
import Post from '../models/userPost.models.js';
import { batchIsLikedByUser, batchGetLikedByUsers, batchGetLikesCount } from '../utils/postEngagement.utils.js';
import { assertCanViewPostById, createPostVisibilityChecker } from './post/visibility.js';
import SaveCollection from '../models/saveCollection.models.js';

/** The caller's own collection, or a 404. */
const resolveOwnCollectionId = async (collectionId, userId) => {
    if (!collectionId) return null;
    if (!mongoose.Types.ObjectId.isValid(String(collectionId))) throw new ApiError(404, "Collection not found");
    const found = await SaveCollection.exists({ _id: collectionId, userId });
    if (!found) throw new ApiError(404, "Collection not found");
    return found._id;
};

/**
 * Save a post to the user's saved posts collection (Instagram-style: Always private)
 * @route POST /api/posts/save
 * @access Private
 */
const savePost = asyncHandler(async (req, res) => {
    const { postId, collectionId } = req.body;
    const userId = req.user._id;

    if (!postId) {
        throw new ApiError(400, "Post ID is required");
    }

    try {
        // Optional: file the save into one of the caller's collections (#54).
        const targetCollectionId = await resolveOwnCollectionId(collectionId, userId);

        // Saving is a READ channel: GET /post/saved plays the row back with the
        // caption, description, media and the whole customization object. So
        // anything the caller may not view must not be savable either. This
        // used to check existence and nothing else, which made
        // save-then-read-saved a two-call bypass of every post-level rule —
        // private posts, blocked authors and private accounts alike.
        await assertCanViewPostById(postId, userId);

        // Check if post is already saved
        const existingSave = await SavedPost.findOne({ userId, postId });

        if (existingSave) {
            if (targetCollectionId) {
                await SavedPost.updateOne({ _id: existingSave._id }, { $addToSet: { collectionIds: targetCollectionId } });
                await SaveCollection.updateOne({ _id: targetCollectionId }, { $set: { updatedAt: new Date() } });
                const updated = await SavedPost.findById(existingSave._id).lean();
                return res.status(200).json(new ApiResponse(200, updated, "Saved to collection"));
            }
            return res.status(200).json(
                new ApiResponse(200, existingSave, "Post already saved")
            );
        }

        // Save post (always private, like Instagram)
        const savedPost = await SavedPost.create({
            userId,
            postId,
            ...(targetCollectionId ? { collectionIds: [targetCollectionId] } : {})
        });
        if (targetCollectionId) {
            await SaveCollection.updateOne({ _id: targetCollectionId }, { $set: { updatedAt: new Date() } });
        }

        // Update save count in the post (optional)
        // await Post.findByIdAndUpdate(postId, { $inc: { 'engagement.saves': 1 } });

        return res.status(201).json(
            new ApiResponse(201, savedPost, "Post saved successfully")
        );
    } catch (error) {
        // Rethrow deliberate ApiErrors untouched. Without this the 404/403
        // raised just above was caught here and re-labelled as a 500, so
        // "post not found" reached the client as "Error saving post".
        if (error instanceof ApiError) throw error;
        if (error.name === 'CastError') {
            throw new ApiError(400, "Invalid post ID format");
        }
        throw new ApiError(500, "Error saving post", [error.message]);
    }
});

/**
 * Unsave/remove a post from user's saved posts collection
 * @route DELETE /api/posts/save/:postId
 * @access Private
 */
const unsavePost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user._id;

    if (!postId) {
        throw new ApiError(400, "Post ID is required");
    }

    try {
        // Check if the post exists
        const post = await Post.findById(postId);

        if (!post) {
            throw new ApiError(404, "Post not found");
        }

        const result = await SavedPost.findOneAndDelete({ userId, postId });

        if (!result) {
            return res.status(404).json(
                new ApiResponse(404, null, "Post not found in saved items")
            );
        }

        // Update save count in the post (optional)
        // await Post.findByIdAndUpdate(postId, { $inc: { 'engagement.saves': -1 } });

        return res.status(200).json(
            new ApiResponse(200, null, "Post removed from saved items")
        );
    } catch (error) {
        if (error.name === 'CastError') {
            throw new ApiError(400, "Invalid post ID format");
        }
        throw new ApiError(500, "Error removing saved post", [error.message]);
    }
});



/**
 * Get all saved posts for the current user (Instagram-style: Only owner can see)
 * @route GET /api/posts/saved
 * @access Private
 */
const getSavedPosts = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { page = 1, limit = 10, collectionId } = req.query;
    const skip = (page - 1) * limit;

    // ?collectionId= lists one collection (#54); without it, everything saved.
    const collectionFilter = collectionId ? { collectionIds: await resolveOwnCollectionId(collectionId, userId) } : {};

    try {
        // Find all saved posts for this user only
        const fetchedSavedPosts = await SavedPost.find({ userId, ...collectionFilter })
            .sort({ savedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate({
                path: 'postId',
                // contentType and postType decide which card the client
                // renders; without them a saved product post came back
                // indistinguishable from a plain photo and lost its price,
                // link and everything else. description is the body text for
                // app-created posts. settings.privacy is not rendered — it is
                // read by the visibility re-check below.
                select: 'caption description contentType postType media customization userId createdAt engagement settings.privacy',
                populate: {
                    path: 'userId',
                    select: 'username fullName profileImageUrl'
                }
            });

        // A save records permission as it stood the day it was made, and
        // permission changes afterwards: the author can turn the post private,
        // block the saver, or make their whole account private. Without this
        // re-check the saved grid kept rendering content every other surface
        // had already stopped showing. Rows whose post is simply gone are left
        // alone — they were always returned with a null postId.
        const canView = createPostVisibilityChecker(userId);
        const visibilityFlags = await Promise.all(
            fetchedSavedPosts.map(s => (s.postId ? canView(s.postId) : Promise.resolve(true)))
        );
        const savedPosts = fetchedSavedPosts.filter((_, i) => visibilityFlags[i]);

        // Get total count for pagination
        const totalSavedPosts = await SavedPost.countDocuments({ userId, ...collectionFilter });

        // Stitch like engagement on populated post objects
        const postDocs = savedPosts.map(s => s.postId).filter(Boolean);
        let enrichedSavedPosts = savedPosts;
        if (postDocs.length) {
            const postIds = postDocs.map(p => p._id);
            const [likedSet, likedByMap, savedLikeCountMap] = await Promise.all([
                batchIsLikedByUser(userId, postIds),
                batchGetLikedByUsers(postIds),
                batchGetLikesCount(postDocs),
            ]);
            enrichedSavedPosts = savedPosts.map(s => {
                const post = s.postId;
                if (!post) return s.toObject ? s.toObject() : s;
                const idStr = post._id.toString();
                const postObj = post.toObject ? post.toObject() : post;
                const enrichedPost = {
                    ...postObj,
                    engagement: {
                        ...postObj.engagement,
                        likes: savedLikeCountMap.get(idStr) ?? postObj.engagement?.likes ?? 0,
                    },
                    isLikedBy: likedSet.has(idStr),
                    likedBy: likedByMap.get(idStr) || [],
                };
                const base = s.toObject ? s.toObject() : { ...s };
                return { ...base, postId: enrichedPost };
            });
        }

        return res.status(200).json(
            new ApiResponse(200, {
                savedPosts: enrichedSavedPosts,
                pagination: {
                    totalPosts: totalSavedPosts,
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalSavedPosts / limit),
                    postsPerPage: parseInt(limit)
                }
            }, "Saved posts retrieved successfully")
        );
    } catch (error) {
        throw new ApiError(500, "Error retrieving saved posts", [error.message]);
    }
});


/**
 * Check if a post is saved by the current user
 * @route GET /api/posts/saved/check/:postId
 * @access Private
 */
const checkPostSaved = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user._id;

    if (!postId) {
        throw new ApiError(400, "Post ID is required");
    }

    try {
        // Check if the post exists
        const post = await Post.findById(postId);

        if (!post) {
            throw new ApiError(404, "Post not found");
        }

        const saved = await SavedPost.findOne({ userId, postId }).select('collectionIds').lean();

        return res.status(200).json(
            new ApiResponse(200, { isSaved: !!saved, collectionIds: saved?.collectionIds || [] }, "Post saved status retrieved")
        );
    } catch (error) {
        if (error.name === 'CastError') {
            throw new ApiError(400, "Invalid post ID format");
        }
        throw new ApiError(500, "Error checking saved post status", [error.message]);
    }
});

export {
    savePost,
    unsavePost,
    getSavedPosts,
    checkPostSaved
};
