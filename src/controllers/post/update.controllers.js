import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post, { deriveHashtags } from "../../models/userPost.models.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import { FeedCacheManager } from "../../utils/cache.utils.js";
import { redisClient } from "../../config/redis.config.js";

export const editPost = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ApiError(401, "User authentication required");

    const {
        caption,
        description,
        mentions,
        tags,
        location,
        privacy,
        product,
        service,
        business
    } = req.body;

    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only edit your own posts");
    }

    const parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : mentions;
    const parsedTags = typeof tags === "string" ? JSON.parse(tags) : tags;
    const parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
    const parsedProduct = typeof product === "string" ? JSON.parse(product) : product;
    const parsedService = typeof service === "string" ? JSON.parse(service) : service;
    const parsedBusiness = typeof business === "string" ? JSON.parse(business) : business;

    let resolvedLocation = parsedLocation || post.customization?.normal?.location;
    if (parsedLocation && (parsedLocation.name || parsedLocation.address) && !parsedLocation.coordinates) {
        try {
            const coords = await getCoordinates(parsedLocation);
            if (coords?.latitude && coords?.longitude) {
                resolvedLocation.coordinates = {
                    type: "Point",
                    coordinates: [coords.longitude, coords.latitude]
                };
            }
        } catch (error) {
            console.error('Error resolving location coordinates during edit:', error.message);
        }
    }

    const updateData = { updatedAt: new Date() };

    if (caption !== undefined) updateData.caption = caption;
    if (description !== undefined) updateData.description = description;
    if (parsedMentions) updateData.mentions = parsedMentions;

    const customization = post.customization?.toObject?.() || { ...post.customization } || {};

    /**
     * Re-geocodes a nested location when its text has changed.
     *
     * editPost geocoded ONLY the top-level `location` body field. The location
     * objects nested inside product/service/business were written straight
     * through, so moving a shop to a new address saved the new text against the
     * OLD coordinates — and every distance search, map pin and "near me" result
     * went on pointing at the previous address indefinitely.
     */
    const regeocodeNested = async (incoming, existing) => {
        if (!incoming) return incoming;
        const textChanged =
            (incoming.address && incoming.address !== existing?.address) ||
            (incoming.name && incoming.name !== existing?.name) ||
            (incoming.city && incoming.city !== existing?.city);
        if (!textChanged || incoming.coordinates) return incoming;
        try {
            const coords = await getCoordinates(incoming);
            if (coords?.latitude && coords?.longitude) {
                return {
                    ...incoming,
                    coordinates: {
                        type: "Point",
                        coordinates: [coords.longitude, coords.latitude],
                    },
                };
            }
        } catch (error) {
            console.error('Error re-geocoding nested location during edit:', error.message);
        }
        return incoming;
    };

    // Type-specific details, merged so anything the client did not send is kept.
    if (post.contentType === "product" && parsedProduct) {
        if (parsedProduct.location) {
            parsedProduct.location = await regeocodeNested(
                parsedProduct.location, customization.product?.location);
        }
        customization.product = { ...(customization.product || {}), ...parsedProduct };
    } else if (post.contentType === "service" && parsedService) {
        if (parsedService.location) {
            parsedService.location = await regeocodeNested(
                parsedService.location, customization.service?.location);
        }
        customization.service = { ...(customization.service || {}), ...parsedService };
    } else if (post.contentType === "business" && parsedBusiness) {
        if (parsedBusiness.location) {
            parsedBusiness.location = await regeocodeNested(
                parsedBusiness.location, customization.business?.location);
        }
        customization.business = { ...(customization.business || {}), ...parsedBusiness };
    }

    // Tags and location are shared by every contentType and are applied
    // UNCONDITIONALLY.
    //
    // This block used to sit inside each branch above, gated on the
    // type-specific object being present — so editing only the tags or only the
    // location of a product post did nothing at all, silently, because
    // `parsedProduct` was undefined and the whole branch was skipped. The
    // request returned 200 and the change simply evaporated.
    customization.normal = {
        ...(customization.normal || {}),
        tags: parsedTags || customization.normal?.tags || [],
        location: resolvedLocation || customization.normal?.location
    };

    updateData.customization = customization;

    // Recompute the hashtag index.
    //
    // `hashtags` is derived by a pre('save') hook on the model, and this
    // controller uses findByIdAndUpdate — which does NOT fire it. So editing a
    // caption changed the visible text while the search index kept the old
    // words forever: a hashtag removed in an edit still matched, and one added
    // never did. Mirrors the hook rather than calling it, because there is no
    // document to save here.
    updateData.hashtags = deriveHashtags({
        caption: caption !== undefined ? caption : post.caption,
        description: description !== undefined ? description : post.description,
        customization,
    });

    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy && privacy === 'public' && oldPrivacy === 'private';

    if (privacy && ['public', 'private'].includes(privacy)) {
        updateData["settings.privacy"] = privacy;
        updateData["settings.isPrivacyTouched"] = true;
    }

    const updatedPost = await Post.findByIdAndUpdate(
        postId,
        { $set: updateData },
        { new: true, runValidators: true }
    ).populate('userId', 'username fullName profileImageUrl');

    await FeedCacheManager.invalidateUserFeed(userId);

    if (isPrivacyChangingToPublic) {
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();
    }

    return res.status(200).json(new ApiResponse(200, updatedPost, "Post updated successfully"));
});

export const togglePostPrivacy = asyncHandler(async (req, res) => {
    const { postId } = req.params;
    const userId = req.user?._id;
    const { privacy } = req.body;

    if (!userId) throw new ApiError(401, "User authentication required");

    if (!privacy || !['public', 'private'].includes(privacy)) {
        throw new ApiError(400, "Invalid privacy value. Must be 'public' or 'private'");
    }

    const post = await Post.findById(postId);
    if (!post) throw new ApiError(404, "Post not found");

    if (post.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You can only modify your own posts");
    }

    const oldPrivacy = post.settings?.privacy || 'public';
    const isPrivacyChangingToPublic = privacy === 'public' && oldPrivacy === 'private';

    const updatedPost = await Post.findByIdAndUpdate(
        postId,
        {
            $set: {
                "settings.privacy": privacy,
                "settings.isPrivacyTouched": true,
                updatedAt: new Date()
            }
        },
        { new: true, runValidators: true }
    ).populate('userId', 'username fullName profileImageUrl');

    if (isPrivacyChangingToPublic) {
        await FeedCacheManager.invalidateExploreFeed();
        await FeedCacheManager.invalidateTrendingFeed();
        await FeedCacheManager.invalidateUserFeed(userId);
    }

    if (privacy === 'private') {
        await redisClient.del(`fn:share:post:${postId}`);
        await redisClient.del(`fn:share:reel:${postId}`);
        await redisClient.del(`fn:share:preview:${postId}`);
        await redisClient.del(`fn:share:preview:reel:${postId}`);
    }

    return res.status(200).json(new ApiResponse(200, {
        postId: updatedPost._id,
        privacy: updatedPost.settings.privacy,
        post: updatedPost
    }, `Post privacy updated to ${privacy}`));
});

/*
 * REMOVED — updatePost.
 *
 * It passed req.body straight into findByIdAndUpdate with no authentication,
 * no req.user read and no ownership comparison, so anyone who could reach it
 * could rewrite any field of any post by id — including userId, engagement
 * counts and settings.privacy.
 *
 * It was never routed, so nothing broke by deleting it. Left in place it was a
 * loaded gun: the next person wiring up a route by name would have shipped an
 * unauthenticated write over the whole collection. editPost above is the real
 * update path and checks ownership on entry.
 */

// saveDraft and schedulePost are not routed today. Both create or publish a Post,
// so any route that exposes either must carry requirePostQuota() (see
// middlewares/subscription.middleware.js) or it bypasses the Free monthly cap.
export const saveDraft = asyncHandler(async (req, res) => {
    const userId = req.user?._id || req.body.userId;
    const postData = req.body;

    const post = await Post.create({
        ...postData,
        userId,
        status: "draft"
    });

    return res.status(201).json(new ApiResponse(201, post, "Post saved as draft"));
});

export const schedulePost = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { scheduledAt } = req.body;
    if (!scheduledAt) throw new ApiError(400, "scheduledAt time is required");

    const post = await Post.findByIdAndUpdate(id, {
        status: "scheduled",
        scheduledAt
    }, { new: true });

    return res.status(200).json(new ApiResponse(200, post, "Post scheduled successfully"));
});
