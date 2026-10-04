import mongoose from 'mongoose';
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import { deleteMultipleFromBunny } from "../../utils/bunny.js";
import { validateDeliveryAndLocation } from "../../utils/deliveryValidation.js";
import { assertProductCapacity } from "../../utils/planLimits.js";
import {
    pushNewPostToBuffer,
    extractMediaFiles,
    parseField,
    resolveLocationCoordinates,
    uploadPostMedia,
    invalidatePostCaches,
} from "./helpers.js";

export const createNormalPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, settings, scheduledAt, publishedAt, status, category, customCategory } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId,
        postType,
        contentType: "normal",
        caption,
        description,
        // Collected and required by the composer; previously dropped on arrival.
        category, customCategory,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    if (post.status === 'published') pushNewPostToBuffer(post._id, userId).catch(() => {});
    //* Home/explore feeds are cached per user for 5 minutes and nothing
    //* cleared them on create, so a new post simply did not appear until
    //* the TTL lapsed — which is why it only showed up via the profile.
    await invalidatePostCaches(post._id, req.user._id);

    return res.status(201).json(new ApiResponse(201, post, "Normal post created successfully"));
});

export const createTweetPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { caption, description, mentions, location, tags, settings, scheduledAt, publishedAt, status, category, customCategory } = req.body;
    if (!caption || !caption.trim()) {
        throw new ApiError(400, "Tweet text (caption) is required");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    // Media is optional for tweets
    const files = extractMediaFiles(req.files);
    const uploadedMedia = files.length ? await uploadPostMedia(files, req.files?.thumbnail?.[0]) : [];

    const post = await Post.create({
        userId,
        postType: "tweet",
        contentType: "normal",
        caption,
        description,
        // Collected and required by the composer; previously dropped on arrival.
        category, customCategory,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            normal: { location: resolvedLocation, tags: parsedTags || [] },
        },
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt,
        publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    if (post.status === 'published') pushNewPostToBuffer(post._id, userId).catch(() => {});
    //* Home/explore feeds are cached per user for 5 minutes and nothing
    //* cleared them on create, so a new post simply did not appear until
    //* the TTL lapsed — which is why it only showed up via the profile.
    await invalidatePostCaches(post._id, req.user._id);

    return res.status(201).json(new ApiResponse(201, post, "Tweet post created successfully"));
});

export const createProductPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    // Plan catalogue cap. Before any parsing or upload so nothing reaches Bunny
    // for a refused product.
    await assertProductCapacity(userId);

    const { postType, caption, description, mentions, mood, activity, location, tags, product, settings, scheduledAt, publishedAt, status, category, customCategory } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedProduct = parseField(product);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedProduct = await validateDeliveryAndLocation({ ...parsedProduct, location: parsedLocation }, "product");
    //* A product link is OPTIONAL. Plenty of sellers have a product and no
    //* website to point at, and refusing the post entirely over a missing URL
    //* blocked them from listing at all. The model has never required it
    //* (`link: { type: String }`), and service posts have never asked for one,
    //* so this check was also the odd one out.

    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "product", caption, description,
        // Collected and required by the composer; previously dropped on arrival.
        category, customCategory,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            product: validatedProduct,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        // Privacy resolved the same way createNormalPost does. Storing
        // parsedSettings raw left privacy at the schema default 'public', so a
        // commercial post ignored BOTH the per-post choice and the account's own
        // privacy setting — a fully private account published public products.
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    if (post.status === 'published') pushNewPostToBuffer(post._id, userId).catch(() => {});
    //* Home/explore feeds are cached per user for 5 minutes and nothing
    //* cleared them on create, so a new post simply did not appear until
    //* the TTL lapsed — which is why it only showed up via the profile.
    await invalidatePostCaches(post._id, req.user._id);

    return res.status(201).json(new ApiResponse(201, post, "Product post created successfully"));
});

export const createServicePost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, service, settings, scheduledAt, publishedAt, status, category, customCategory } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedService = parseField(service);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedService = await validateDeliveryAndLocation({ ...parsedService, location: parsedLocation }, "service");
    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "service", caption, description,
        // Collected and required by the composer; previously dropped on arrival.
        category, customCategory,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            service: validatedService,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        // Privacy resolved the same way createNormalPost does. Storing
        // parsedSettings raw left privacy at the schema default 'public', so a
        // commercial post ignored BOTH the per-post choice and the account's own
        // privacy setting — a fully private account published public products.
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    if (post.status === 'published') pushNewPostToBuffer(post._id, userId).catch(() => {});
    //* Home/explore feeds are cached per user for 5 minutes and nothing
    //* cleared them on create, so a new post simply did not appear until
    //* the TTL lapsed — which is why it only showed up via the profile.
    await invalidatePostCaches(post._id, req.user._id);

    return res.status(201).json(new ApiResponse(201, post, "Service post created successfully"));
});

export const createBusinessPost = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    const { postType, caption, description, mentions, mood, activity, location, tags, business, settings, scheduledAt, publishedAt, status, category, customCategory } = req.body;
    if (!postType || !["photo", "reel", "video", "story", "tweet"].includes(postType)) {
        throw new ApiError(400, "postType must be one of 'photo', 'reel', 'video', 'story', or 'tweet'");
    }

    const parsedMentions = parseField(mentions);
    const parsedTags = parseField(tags);
    const parsedBusiness = parseField(business);
    const parsedSettings = parseField(settings);
    const parsedLocation = parseField(location);

    const validatedBusiness = await validateDeliveryAndLocation({ ...parsedBusiness, location: parsedLocation }, "business");
    if (!validatedBusiness?.link) throw new ApiError(400, "Business post must include a business link");

    const resolvedLocation = await resolveLocationCoordinates(parsedLocation);

    const files = extractMediaFiles(req.files);
    if (!files.length) throw new ApiError(400, "Media file is required");

    const uploadedMedia = await uploadPostMedia(files, req.files?.thumbnail?.[0]);

    const post = await Post.create({
        userId, postType, contentType: "business", caption, description,
        // Collected and required by the composer; previously dropped on arrival.
        category, customCategory,
        mentions: parsedMentions || [],
        media: uploadedMedia,
        customization: {
            business: validatedBusiness,
            normal: { mood, activity, location: resolvedLocation, tags: parsedTags || [] },
        },
        // Privacy resolved the same way createNormalPost does. Storing
        // parsedSettings raw left privacy at the schema default 'public', so a
        // commercial post ignored BOTH the per-post choice and the account's own
        // privacy setting — a fully private account published public products.
        settings: {
            ...parsedSettings,
            privacy: parsedSettings?.privacy || req.user?.privacy || 'public',
            isPrivacyTouched: parsedSettings?.privacy ? true : false
        },
        scheduledAt, publishedAt,
        status: status || (scheduledAt ? "scheduled" : "published"),
        isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
        engagement: {}, analytics: {},
    });

    await Post.db.model('User').findByIdAndUpdate(userId, { $push: { posts: post._id } });
    if (post.status === 'published') pushNewPostToBuffer(post._id, userId).catch(() => {});
    //* Home/explore feeds are cached per user for 5 minutes and nothing
    //* cleared them on create, so a new post simply did not appear until
    //* the TTL lapsed — which is why it only showed up via the profile.
    await invalidatePostCaches(post._id, req.user._id);

    return res.status(201).json(new ApiResponse(201, post, "Business post created successfully"));
});

export const createBatchPosts = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(400, "User ID is required");

    let posts;
    try {
        posts = typeof req.body.posts === "string" ? JSON.parse(req.body.posts) : req.body.posts;
    } catch {
        throw new ApiError(400, "Invalid posts data. Must be a valid JSON array.");
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        throw new ApiError(400, "posts must be a non-empty array");
    }
    if (posts.length > 6) {
        throw new ApiError(400, "Maximum 6 posts allowed per batch");
    }

    const validPostTypes = ["photo", "reel", "video", "story", "tweet"];
    const validContentTypes = ["normal", "product", "service", "business"];

    // Phase 1: Validate all posts before any uploads
    const parsedPosts = [];
    for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const contentType = p.contentType || "normal";
        const postType = p.postType;

        if (!postType || !validPostTypes.includes(postType)) {
            throw new ApiError(400, `Post ${i + 1}: postType must be one of '${validPostTypes.join("', '")}'`);
        }
        if (!validContentTypes.includes(contentType)) {
            throw new ApiError(400, `Post ${i + 1}: contentType must be one of '${validContentTypes.join("', '")}'`);
        }

        const parsedMentions = parseField(p.mentions);
        const parsedTags = parseField(p.tags);
        const parsedSettings = parseField(p.settings);
        const parsedLocation = parseField(p.location);

        const images = req.files?.[`post_${i}_image`] || [];
        const videos = req.files?.[`post_${i}_video`] || [];
        const thumbnail = req.files?.[`post_${i}_thumbnail`]?.[0] || null;
        const files = [...images, ...videos];

        if (postType !== "tweet" && !files.length) {
            throw new ApiError(400, `Post ${i + 1}: Media file is required for ${postType} posts`);
        }
        if (postType === "tweet" && (!p.caption || !p.caption.trim())) {
            throw new ApiError(400, `Post ${i + 1}: Tweet text (caption) is required`);
        }

        let validatedDetails = null;
        if (contentType === "product") {
            const parsedProduct = parseField(p.product);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedProduct, location: parsedLocation }, "product");
            //* Optional — see the single-create path above. Left required here,
            //* the bulk endpoint would reject a whole batch over one missing URL.
        } else if (contentType === "service") {
            const parsedService = parseField(p.service);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedService, location: parsedLocation }, "service");
        } else if (contentType === "business") {
            const parsedBusiness = parseField(p.business);
            validatedDetails = await validateDeliveryAndLocation({ ...parsedBusiness, location: parsedLocation }, "business");
            if (!validatedDetails?.link) {
                throw new ApiError(400, `Post ${i + 1}: Business post must include a business link`);
            }
        }

        parsedPosts.push({
            postType, contentType,
            caption: p.caption, description: p.description,
            mood: p.mood, activity: p.activity,
            parsedMentions, parsedTags, parsedSettings, parsedLocation,
            validatedDetails, files, thumbnail,
            scheduledAt: p.scheduledAt, publishedAt: p.publishedAt, status: p.status,
        });
    }

    // Catalogue cap for the products in this batch, checked once and before any
    // upload so a refused batch puts nothing on Bunny. The batch is atomic, so it
    // is accepted or refused as a whole.
    const productCount = parsedPosts.filter((p) => p.contentType === "product").length;
    if (productCount > 0) await assertProductCapacity(userId, productCount);

    // Phase 2: Upload media for all posts + resolve locations.
    // Run the posts concurrently. Sequentially, a 6-post batch cost 6 x the
    // per-post upload time inside a single request the client is blocked on,
    // which is what pushed batch creation past the mobile client's timeout.
    // allSettled, not all: if one post fails we still need the URLs the posts
    // that succeeded already put on Bunny, so cleanup can remove them.
    const allUploadedUrls = [];

    const settled = await Promise.allSettled(parsedPosts.map(async (p) => {
        const uploadedMedia = p.files.length ? await uploadPostMedia(p.files, p.thumbnail) : [];
        const resolvedLocation = await resolveLocationCoordinates(p.parsedLocation);
        return { uploadedMedia, resolvedLocation };
    }));

    for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
            allUploadedUrls.push(...outcome.value.uploadedMedia.map(m => m.url));
        }
    }

    const failure = settled.find(outcome => outcome.status === 'rejected');
    if (failure) {
        if (allUploadedUrls.length > 0) {
            await deleteMultipleFromBunny(allUploadedUrls).catch(err => console.error("Cleanup failed:", err));
        }
        throw failure.reason;
    }

    const postMediaAndLocations = settled.map(outcome => outcome.value);

    // Phase 3: Create all posts in a transaction
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const createdPosts = [];
        for (let i = 0; i < parsedPosts.length; i++) {
            const p = parsedPosts[i];
            const { uploadedMedia, resolvedLocation } = postMediaAndLocations[i];

            const customization = {
                normal: { mood: p.mood, activity: p.activity, location: resolvedLocation, tags: p.parsedTags || [] },
            };
            if (p.contentType === "product") customization.product = p.validatedDetails;
            if (p.contentType === "service") customization.service = p.validatedDetails;
            if (p.contentType === "business") customization.business = p.validatedDetails;

            const postSettings = p.contentType === "normal" ? {
                ...p.parsedSettings,
                privacy: p.parsedSettings?.privacy || req.user?.privacy || 'public',
                isPrivacyTouched: p.parsedSettings?.privacy ? true : false
            } : (p.parsedSettings || {});

            const [created] = await Post.create([{
                userId,
                postType: p.postType,
                contentType: p.contentType,
                caption: p.caption,
                description: p.description,
                mentions: p.parsedMentions || [],
                media: uploadedMedia,
                customization,
                settings: postSettings,
                scheduledAt: p.scheduledAt,
                publishedAt: p.publishedAt,
                status: p.status || (p.scheduledAt ? "scheduled" : "published"),
                isPromoted: false, isFeatured: false, isReported: false, reportCount: 0,
                engagement: {}, analytics: {},
            }], { session });

            createdPosts.push(created);
        }

        await Post.db.model('User').findByIdAndUpdate(
            userId,
            { $push: { posts: { $each: createdPosts.map(p => p._id) } } },
            { session }
        );

        await session.commitTransaction();

        //* Same as the single-post endpoints: without this the cached feeds
        //* keep serving the pre-post list for up to 5 minutes, so a multi-post
        //* upload appears to have done nothing.
        await invalidatePostCaches(createdPosts[0]?._id, userId);

        return res.status(201).json(
            new ApiResponse(201, { posts: createdPosts, count: createdPosts.length }, `${createdPosts.length} posts created successfully`)
        );
    } catch (error) {
        await session.abortTransaction();
        if (allUploadedUrls.length > 0) {
            await deleteMultipleFromBunny(allUploadedUrls).catch(err => console.error("Cleanup failed:", err));
        }
        throw error;
    } finally {
        session.endSession();
    }
});
