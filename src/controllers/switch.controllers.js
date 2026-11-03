import { authorOrCollabFilter, attachCollaborators } from '../utils/collab.utils.js';
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import TaggedUser from "../models/taggedUser.models.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { batchIsLikedByUser } from "../utils/postEngagement.utils.js";
import { checkContentVisibility } from "../middlewares/privacy.middleware.js";

const allowedTabs = ["photos", "reels", "videos", "tagged", "stories"];
const postProjection = {
    _id: 1,
    userId: 1,
    media: 1,
    caption: 1,
    createdAt: 1,
    postType: 1,
    contentType: 1,
    status: 1,
    collaborators: 1
};
const storyProjection = {
    _id: 1,
    userId: 1,
    media: 1,
    createdAt: 1,
    expiresAt: 1,
    isArchived: 1
};

export const getProfileTabContent = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    let { tab = "photos", page = 1, limit = 12 } = req.query;
    page = parseInt(page);
    limit = parseInt(limit);
    const skip = (page - 1) * limit;
    const currentUserId = req.user?._id?.toString();

    // Validation
    if (!userId) throw new ApiError(400, "User ID is required");
    if (!allowedTabs.includes(tab)) throw new ApiError(400, "Invalid tab type");
    if (!Number.isInteger(page) || page < 1) throw new ApiError(400, "Page must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1) throw new ApiError(400, "Limit must be a positive integer");

    // Privacy. There was NONE here: every tab queried on userId alone, so any
    // signed-in caller could read any account's photos, reels, videos and
    // tweets — private accounts included — and private posts came back with
    // the rest. verifyJWT on the route only proved the caller was *someone*,
    // not that they were allowed to see this.
    //
    // checkContentVisibility covers the three cases together: own content,
    // a blocking relationship in either direction, and the target's privacy
    // setting. It takes a null viewer, which is what lets a signed-out visitor
    // browse a public profile.
    const isOwnProfile = currentUserId === userId?.toString();
    if (!isOwnProfile) {
        const canView = await checkContentVisibility(currentUserId, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their posts.");
        }
    }

    // Posts the author marked private stay with the author, even on a public
    // account — the same rule the reels feed applies.
    const privacyFilter = isOwnProfile ? {} : { "settings.privacy": { $ne: "private" } };

    let data = [], total = 0;

    switch (tab) {
        case "photos": {
            const filter = {
                // Own posts plus accepted collabs (#50).
                ...authorOrCollabFilter(userId),
                postType: { $in: ["photo", "video"] },
                contentType: "normal",
                status: { $in: ["published", "scheduled"] },
                ...privacyFilter
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "reels": {
            const filter = {
                // Own posts plus accepted collabs (#50).
                ...authorOrCollabFilter(userId),
                postType: "reel",
                status: { $in: ["published", "scheduled"] },
                ...privacyFilter
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "videos": {
            const filter = {
                // Own posts plus accepted collabs (#50).
                ...authorOrCollabFilter(userId),
                postType: "video",
                contentType: { $ne: "normal" },
                status: { $in: ["published", "scheduled"] },
                ...privacyFilter
            };
            data = await Post.find(filter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Post.countDocuments(filter);
            break;
        }
        case "tagged": {
            // Get all tagged post/reel IDs for this user
            const tagged = await TaggedUser.find({ userId, targetType: { $in: ["Post", "Reel"] } })
                .sort({ taggedAt: -1 })
                .lean();
            const postIds = tagged.map(t => t.targetId);
            // Paginate posts directly
            // A tagged post belongs to whoever wrote it, not to this profile,
            // so the account-level check above does not cover it. Filter on the
            // posts' own privacy flag instead; a full per-author visibility
            // check would need one lookup per post.
            //
            // privacyFilter is NOT usable here: it is {} on your own profile,
            // which is correct for your own posts but wrong for a tagged one —
            // it dropped the AUTHOR's settings.privacy:'private' flag, so
            // tagging someone in a private post handed them the post (and its
            // public CDN media URL) the moment they opened their Tagged tab.
            // A private post of your OWN that you were tagged in still shows.
            const taggedPrivacyFilter = currentUserId
                ? {
                    $or: [
                        { "settings.privacy": { $ne: "private" } },
                        { userId: currentUserId }
                    ]
                }
                : { "settings.privacy": { $ne: "private" } };
            const taggedFilter = { _id: { $in: postIds }, ...taggedPrivacyFilter };
            total = await Post.countDocuments(taggedFilter);
            data = await Post.find(taggedFilter, postProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            break;
        }
        case "stories": {
            const now = new Date();
            const filter = {
                userId,
                isArchived: false,
                expiresAt: { $gt: now }
            };
            data = await Story.find(filter, storyProjection)
                .populate("userId", "username profileImageUrl")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            total = await Story.countDocuments(filter);
            break;
        }
    }

    // Collab co-authors on the grid tiles (#50).
    if (["photos", "reels", "videos"].includes(tab) && data.length > 0) {
        await attachCollaborators(data, currentUserId);
    }

    // Add isLikedBy for posts (not stories)
    if (["photos", "reels", "videos", "tagged"].includes(tab) && data.length > 0 && currentUserId) {
        const postIds = data.map(post => post._id);
        const likedSet = await batchIsLikedByUser(currentUserId, postIds);
        data = data.map(post => ({
            ...post,
            isLikedBy: likedSet.has(post._id.toString())
        }));
    }

    return res.status(200).json(
        new ApiResponse(200, {
            tab,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            data
        }, `Fetched ${tab} for user profile`)
    );
});
