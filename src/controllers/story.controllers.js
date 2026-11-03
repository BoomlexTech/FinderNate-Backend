import Story from "../models/story.models.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { uploadBufferToBunny } from "../utils/bunny.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/user.models.js";
import Business from "../models/business.models.js";
import Follower from "../models/follower.models.js";
import { checkContentVisibility } from "../middlewares/privacy.middleware.js";
import { POST_MEDIA_LIMITS_MB, tooLargeMessage } from "../constants/uploadLimits.js";

// 1. Upload Story
export const uploadStory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    if (!req.file) throw new ApiError(400, "Media file is required");

    // A story is an image or a video — mediaType has no other value. The route
    // uses the shared multer instance, which also accepts audio and documents,
    // so without this a PDF uploaded by mistake was stored as a ".bin" and
    // written to the ring as mediaType "image": an unopenable grey box the
    // author was told had uploaded successfully. Size was unchecked too, so
    // anything up to multer's 600 MB global ceiling was accepted whatever its
    // type; the per-type ceilings below are the ones posts and reels use.
    const mime = req.file.mimetype || '';
    const isVideo = mime.startsWith('video/');
    const isImage = mime.startsWith('image/');
    if (!isImage && !isVideo) {
        throw new ApiError(400, `File type "${mime}" is not allowed. A story must be an image or a video.`);
    }

    const category = isVideo ? 'video' : 'image';
    const limitMB = POST_MEDIA_LIMITS_MB[category];
    if (req.file.size > limitMB * 1024 * 1024) {
        // 413, matching uploadSingleMedia: a payload-size refusal, not a bad request.
        throw new ApiError(413, tooLargeMessage({
            category,
            actualBytes: req.file.size,
            limitMB,
        }));
    }

    const result = await uploadBufferToBunny(req.file.buffer, "stories");
    if (!result.secure_url) throw new ApiError(500, "Failed to upload story media");

    // Second gate, on what the bytes actually are rather than what the client
    // called them. uploadBufferToBunny identifies the file from its magic bytes
    // and names it from that; a buffer it cannot identify — a document sent as
    // "image/jpeg", a truncated upload — is stored as ".bin" and would become a
    // story the app can only render as a grey box. Remove it again instead.
    if (result.format === 'bin' || (result.resource_type !== 'image' && result.resource_type !== 'video')) {
        try {
            const { deleteFromBunny } = await import("../utils/bunny.js");
            await deleteFromBunny(result.secure_url);
        } catch (error) {
            console.error('⚠️ Failed to clean up rejected story media:', error.message);
        }
        throw new ApiError(400, "That file could not be read as an image or a video. Try a JPEG, PNG or MP4.");
    }

    const story = await Story.create({
        userId,
        mediaUrl: result.secure_url,
        mediaType: result.resource_type === "video" ? "video" : "image",
        caption: req.body.caption || "",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    // Map mediaType to postType, remove mediaType and viewers from response
    const storyObj = story.toObject();
    storyObj.postType = storyObj.mediaType;
    delete storyObj.mediaType;
    delete storyObj.viewers;

    res.status(201).json(new ApiResponse(201, storyObj, "Story uploaded successfully"));
});

// 2. Fetch Stories from followed users (and self) - excluding blocked users
export const fetchStoriesFeed = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const blockedUsers = req.blockedUsers || [];

    // Who this viewer follows, and who follows them.
    //
    // Read from the Follower COLLECTION, which is the only place a follow is
    // recorded: onUserFollowed upserts a Follower row and never touches the
    // legacy User.following / User.followers arrays this used to read. Those
    // arrays are empty on every account created since, so Rule 5 below could
    // never match anyone — a private account's stories were invisible to its
    // own followers, and after a block was lifted they still never came back,
    // because the rule that was supposed to re-include them had nothing to
    // match against.
    const [followingRecords, followerRecords] = await Promise.all([
        Follower.find({ followerId: userId }).select("userId").lean(),
        Follower.find({ userId }).select("followerId").lean()
    ]);
    const following = followingRecords.map(f => f.userId.toString());
    const followers = followerRecords.map(f => f.followerId.toString());

    const now = new Date();

    // Get active stories and populate user info including privacy.
    //
    // This used to load EVERY live story on the platform in one unbounded
    // query and populate an author document for each, then filter in Node —
    // the cost of one tray load grew with the whole platform's posting rate
    // rather than with what this viewer can actually see. The scan is capped
    // now. The viewer's own stories are fetched separately and merged, so a
    // busy hour elsewhere on the platform can never push a person's own story
    // out of their own tray.
    const OWN_STORIES_LIMIT = 50;
    const FEED_SCAN_LIMIT = 300;
    const STORY_AUTHOR_FIELDS = "username profileImageUrl privacy isFullPrivate followers following isBusinessProfile accountStatus isDeleted";

    const [ownStories, otherStories] = await Promise.all([
        Story.find({ userId, isArchived: false, expiresAt: { $gt: now } })
            .sort({ createdAt: -1 })
            .limit(OWN_STORIES_LIMIT)
            .populate("userId", STORY_AUTHOR_FIELDS),
        Story.find({ userId: { $ne: userId }, isArchived: false, expiresAt: { $gt: now } })
            .sort({ createdAt: -1 })
            .limit(FEED_SCAN_LIMIT)
            .populate("userId", STORY_AUTHOR_FIELDS)
    ]);

    // Newest first across both queries, matching the single-query ordering the
    // clients already render.
    const allStories = [...ownStories, ...otherStories].sort(
        (a, b) => b.createdAt - a.createdAt
    );

    // Get active payment plan user IDs and business user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));

    // Filter stories based on privacy rules AND business payment plan rules
    const visibleStories = allStories.filter(story => {
        // A story whose author was deleted populates userId as null.
        if (!story.userId) {
            return false;
        }

        const storyOwnerId = story.userId._id.toString();
        // Private by EITHER flag — see checkContentVisibility on why both are
        // consulted rather than `privacy` alone.
        const isPrivateAccount = story.userId.privacy === 'private' || story.userId.isFullPrivate === true;
        const isBusinessAccount = story.userId.isBusinessProfile || false;
        const hasActivePlan = activePlanUserIdsSet.has(storyOwnerId);

        // Rule 1: Always show own stories
        if (storyOwnerId === userId.toString()) {
            return true;
        }

        // Rule 2: Never show stories from blocked users (mutual blocking)
        if (blockedUsers.includes(storyOwnerId)) {
            return false;
        }

        // Rule 3: Nothing from a removed or banned account
        if (story.userId.isDeleted || ['deactivated', 'banned'].includes(story.userId.accountStatus)) {
            return false;
        }

        // Rule 4: Hide unpaid business stories from ALL users (including followers)
        if (isBusinessAccount && !hasActivePlan) {
            return false;
        }

        // Rule 5: If story owner has PUBLIC account → show to everyone
        if (!isPrivateAccount) {
            return true;
        }

        // Rule 6: If story owner has PRIVATE account → only show to followers/following
        return following.includes(storyOwnerId) || followers.includes(storyOwnerId);
    });

    // Map mediaType to postType and remove viewers
    const storiesWithPostType = visibleStories.map(story => {
        const obj = story.toObject();
        obj.postType = obj.mediaType;
        delete obj.mediaType;
        delete obj.viewers;
        // Remove privacy/moderation fields from user object in response
        if (obj.userId) {
            delete obj.userId.privacy;
            delete obj.userId.isFullPrivate;
            delete obj.userId.accountStatus;
            delete obj.userId.isDeleted;
            delete obj.userId.followers;
            delete obj.userId.following;
        }
        return obj;
    });

    res.status(200).json(new ApiResponse(200, storiesWithPostType, "Stories feed fetched"));
});
// 3. Fetch Stories by user id
export const fetchStoriesByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const viewerId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];

    // Rule 1: Check if user is blocked
    if (blockedUsers.includes(userId)) {
        throw new ApiError(403, "You don't have permission to view this user's stories");
    }

    // Rule 2: Get target user's privacy settings
    const targetUser = await User.findById(userId).select('privacy isFullPrivate username profileImageUrl');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    // Rule 3: Check if viewer can see this user's content
    const isOwnStory = viewerId?.toString() === userId;
    // Public means public by BOTH flags: an account with isFullPrivate set and
    // a stale privacy:'public' skipped the check below entirely.
    const isPublicAccount = targetUser.privacy === 'public' && targetUser.isFullPrivate !== true;

    if (!isOwnStory && !isPublicAccount) {
        // For private accounts, check if viewer is following
        if (!viewerId) {
            throw new ApiError(403, "This account is private");
        }

        // Use the existing privacy check function
        const canView = await checkContentVisibility(viewerId, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their stories.");
        }
    }

    // Get active payment plan user IDs and business user IDs
    const activePaymentPlanUserIds = await Business.find({
        subscriptionStatus: 'active',
        plan: { $ne: 'plan1' }
    }).select('userId').lean();
    const activePlanUserIdsSet = new Set(activePaymentPlanUserIds.map(b => b.userId.toString()));
    
    const targetUserFull = await User.findById(userId).select('isBusinessProfile');
    const isBusinessAccount = targetUserFull?.isBusinessProfile || false;
    const hasActivePlan = activePlanUserIdsSet.has(userId);

    const now = new Date();
    const stories = await Story.find({
        userId,
        isArchived: false,
        expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });

    // Filter out unpaid business stories (hide from ALL users including
    // followers) — but NEVER from their author. fetchStoriesFeed already
    // exempts the owner ("Rule 1: Always show own stories"); this path did
    // not, so an unpaid business account posted a status and then could not
    // see it on its own profile, which reads as the upload having failed.
    const filteredStories = stories.filter(() => {
        if (isOwnStory) return true;
        if (isBusinessAccount && !hasActivePlan) {
            return false;
        }
        return true;
    });

    // Map mediaType to postType and remove viewers
    const storiesWithPostType = filteredStories.map(story => {
        const obj = story.toObject();
        obj.postType = obj.mediaType;
        delete obj.mediaType;

        // The author gets a count of who has seen each story; nobody else
        // learns anything about the audience. The identities stay behind
        // GET /stories/:storyId/viewers, which is owner-only — this is just
        // the number, so the badge can render without opening that screen.
        // The story's own author never counts as a viewer of it.
        if (isOwnStory) {
            // Deduplicated, for the same reason fetchStoryViewers dedupes:
            // markStorySeen used a non-atomic push, so an id can appear twice
            // on stories seen before that was fixed.
            const ownerId = story.userId.toString();
            obj.viewerCount = new Set(
                (obj.viewers || [])
                    .map(v => v.toString())
                    .filter(v => v !== ownerId)
            ).size;
        }
        delete obj.viewers;
        return obj;
    });

    res.status(200).json(new ApiResponse(200, storiesWithPostType, "User's stories fetched"));
});

// 4. Mark Story as Seen
export const markStorySeen = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { storyId } = req.body;
    const blockedUsers = req.blockedUsers || [];

    const story = await Story.findById(storyId);
    if (!story) throw new ApiError(404, "Story not found");

    // Don't allow marking stories as seen from blocked users
    if (blockedUsers.includes(story.userId.toString())) {
        throw new ApiError(403, "Cannot view this story");
    }

    const isOwnStory = story.userId.toString() === userId.toString();

    // A visibility gate. Only the block list was checked here, so anyone
    // holding a story id — they travel in share links — could write themselves
    // into a private account's viewer list for a story they were never allowed
    // to open.
    //
    // The rules are fetchStoriesFeed's, not fetchStoriesByUser's, because the
    // feed is where a story is opened from: it shows a private account's
    // stories to people who follow that account AND to people that account
    // follows (Rule 6). Gating on checkContentVisibility alone would 403 the
    // second group on a story the tray had just shown them.
    if (!isOwnStory) {
        const owner = await User.findById(story.userId)
            .select('privacy isFullPrivate accountStatus isDeleted')
            .lean();
        if (!owner || owner.isDeleted || ['deactivated', 'banned'].includes(owner.accountStatus)) {
            throw new ApiError(403, "Cannot view this story");
        }

        const isPrivateAccount = owner.privacy === 'private' || owner.isFullPrivate === true;
        if (isPrivateAccount) {
            const isConnected = await Follower.exists({
                $or: [
                    { userId: story.userId, followerId: userId },  // viewer follows the author
                    { userId, followerId: story.userId }           // the author follows the viewer
                ]
            });
            if (!isConnected) {
                throw new ApiError(403, "Cannot view this story");
            }
        }
    }

    // Don't add the story owner to viewers.
    //
    // $addToSet, applied by the database rather than read-check-push-save: the
    // app fires this twice on a fast open, and both calls used to pass the
    // in-memory includes() check and push the same viewer twice, inflating the
    // count the author is shown.
    if (!isOwnStory) {
        await Story.updateOne({ _id: story._id }, { $addToSet: { viewers: userId } });
    }

    res.status(200).json(new ApiResponse(200, {}, "Story marked as seen"));
});

// 5. Fetch list of seen people for a story
export const fetchStoryViewers = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const story = await Story.findById(storyId).select("userId viewers").lean();
    if (!story) throw new ApiError(404, "Story not found");

    // Owner only. This previously answered for ANY authenticated caller, so
    // anyone holding a story id could enumerate who had watched someone else's
    // story — the audience for a story is private to its author everywhere
    // else, and the app only ever offers this screen to the author anyway.
    if (story.userId.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "Only the author can see who viewed this story");
    }

    // Filter out the story owner from viewers (safety measure), and collapse
    // any duplicate ids left behind by the old non-atomic push in
    // markStorySeen — they made the total the author sees too high.
    const ownerId = story.userId.toString();
    const seenIds = new Set();
    const viewerIds = [];
    for (const viewerId of story.viewers || []) {
        const key = viewerId.toString();
        if (key === ownerId || seenIds.has(key)) continue;
        seenIds.add(key);
        viewerIds.push(viewerId);
    }

    // Pagination logic
    const pageNum = Math.max(parseInt(page) || 1, 1);
    // Clamped: the page size decides how many User documents this loads.
    const pageSize = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const start = (pageNum - 1) * pageSize;
    const end = start + pageSize;
    const totalViewers = viewerIds.length;
    const pageIds = viewerIds.slice(start, end);

    // Only this page's viewers are loaded. populate() fetched a User document
    // for every viewer in the array on every request, so page 2 of a story
    // with 60,000 views still read all 60,000 profiles to return twenty.
    //
    // fullName as well as username: the list is rendered as a profile row, and
    // a username alone is not who people recognise each other by.
    const viewerDocs = await User.find({ _id: { $in: pageIds } })
        .select("username fullName profileImageUrl")
        .lean();
    const viewerById = new Map(viewerDocs.map(u => [u._id.toString(), u]));
    // Keep the order of the viewers array — $in comes back in index order.
    const paginatedViewers = pageIds
        .map(id => viewerById.get(id.toString()))
        .filter(Boolean);

    res.status(200).json(new ApiResponse(200, {
        viewers: paginatedViewers,
        pagination: {
            page: pageNum,
            limit: pageSize,
            total: totalViewers,
            totalPages: Math.ceil(totalViewers / pageSize),
            hasNextPage: end < totalViewers,
            hasPrevPage: start > 0
        }
    }, "Story viewers fetched"));
});

// 6. Fetch archived stories by user
export const fetchArchivedStoriesByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const viewerId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];
    const { page = 1, limit = 10 } = req.query;

    // Rule 1: Check if user is blocked
    if (blockedUsers.includes(userId)) {
        throw new ApiError(403, "You don't have permission to view this user's archived stories");
    }

    // Rule 2: Get target user's privacy settings
    const targetUser = await User.findById(userId).select('privacy isFullPrivate username profileImageUrl');
    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    // Rule 3: Check if viewer can see this user's content
    const isOwnStory = viewerId?.toString() === userId;
    // Public means public by BOTH flags — see fetchStoriesByUser.
    const isPublicAccount = targetUser.privacy === 'public' && targetUser.isFullPrivate !== true;

    if (!isOwnStory && !isPublicAccount) {
        // For private accounts, check if viewer is following
        if (!viewerId) {
            throw new ApiError(403, "This account is private");
        }

        // Use the existing privacy check function
        const canView = await checkContentVisibility(viewerId, userId);
        if (!canView) {
            throw new ApiError(403, "This account is private. Follow to see their stories.");
        }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [stories, total] = await Promise.all([
        Story.find({ userId, isArchived: true })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .select("-viewers -mediaType") // remove viewers and mediaType from response
            .lean()
            .exec(),
        Story.countDocuments({ userId, isArchived: true })
    ]);

    // Map mediaType to postType in response if needed
    const storiesWithPostType = stories.map(story => {
        story.postType = story.mediaType;
        delete story.mediaType;
        return story;
    });

    res.status(200).json(new ApiResponse(200, {
        stories: storiesWithPostType,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
            hasNextPage: skip + stories.length < total,
            hasPrevPage: skip > 0
        }
    }, "User's archived stories fetched"));
});

// 7. Delete Story
export const deleteStory = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const userId = req.user._id;

    // Find the story
    const story = await Story.findById(storyId);
    if (!story) {
        throw new ApiError(404, "Story not found");
    }

    // Check if the user owns this story
    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You are not authorized to delete this story");
    }

    // Into the Bin for 15 days (Phase 2 #15); the purge job deletes the media.
    const { moveToBin } = await import("../utils/bin.utils.js");
    const binItem = await moveToBin('story', story, userId);

    res.status(200).json(new ApiResponse(200, { storyId, inBin: true, binId: binItem._id, purgeAfter: binItem.purgeAfter }, "Story moved to your Bin"));
});

// Shared response shaping for the archive toggles: same field mapping the other
// story endpoints use (mediaType → postType, viewers never leave the server).
const toStoryResponse = (story) => {
    const obj = { ...story };
    obj.postType = obj.mediaType;
    delete obj.mediaType;
    delete obj.viewers;
    return obj;
};

// 8. Archive a story (author only)
//
// isArchived has existed on the schema, been read by fetchArchivedStoriesByUser
// and been honoured by the purge job since the beginning, but nothing ever set
// it — so every archive list was empty for everyone. This is the missing write.
//
// Archiving is the "keep this past its 24 hours" action: the expiry job skips
// isArchived rows (see the filter in src/jobs/storyExpiry.job.js), so the row
// and its media survive. It also takes the story out of the live tray and the
// profile stories tab immediately, because both filter isArchived: false.
//
// Only a story that is still live can be archived. Once expiresAt has passed
// the story is already invisible everywhere and is a purge candidate — a worker
// may be part-way through deleting its media at this very moment — so letting
// it be archived then would resurrect a half-deleted row. The atomic
// findOneAndUpdate below is what enforces that: the guard is evaluated by the
// database, not read-then-write.
export const archiveStory = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const userId = req.user._id;

    const story = await Story.findById(storyId).select("userId isArchived").lean();
    if (!story) throw new ApiError(404, "Story not found");

    // Owner only — nobody may archive somebody else's story. Checked before the
    // update so a non-owner gets 403 rather than the "expired" 409 below.
    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You are not authorized to archive this story");
    }

    if (story.isArchived) {
        const current = await Story.findById(storyId).lean();
        return res.status(200).json(
            new ApiResponse(200, toStoryResponse(current), "Story is already archived")
        );
    }

    const updated = await Story.findOneAndUpdate(
        { _id: storyId, userId, isArchived: false, expiresAt: { $gt: new Date() } },
        { $set: { isArchived: true } },
        { new: true }
    ).lean();

    if (!updated) {
        throw new ApiError(409, "This story has expired and can no longer be archived");
    }

    res.status(200).json(new ApiResponse(200, toStoryResponse(updated), "Story archived"));
});

// 9. Un-archive a story (author only)
//
// The undo for the above, and only that: it puts the story back into the normal
// 24-hour lifecycle. That is only meaningful while the story is still within
// that window — un-archiving one whose expiresAt has passed would not put it
// back in anyone's tray (every live query also filters expiresAt > now), it
// would only hand the row and its media to the next purge pass. Deleting a
// story is what DELETE /stories/:storyId is for; a restore toggle must not be
// the thing that silently destroys the media, so that case is refused.
export const unarchiveStory = asyncHandler(async (req, res) => {
    const { storyId } = req.params;
    const userId = req.user._id;

    const story = await Story.findById(storyId).select("userId isArchived expiresAt").lean();
    if (!story) throw new ApiError(404, "Story not found");

    if (story.userId.toString() !== userId.toString()) {
        throw new ApiError(403, "You are not authorized to un-archive this story");
    }

    if (!story.isArchived) {
        const current = await Story.findById(storyId).lean();
        return res.status(200).json(
            new ApiResponse(200, toStoryResponse(current), "Story is not archived")
        );
    }

    const updated = await Story.findOneAndUpdate(
        { _id: storyId, userId, isArchived: true, expiresAt: { $gt: new Date() } },
        { $set: { isArchived: false } },
        { new: true }
    ).lean();

    if (!updated) {
        throw new ApiError(
            409,
            "This story's 24 hours are already over, so it can only stay archived or be deleted"
        );
    }

    res.status(200).json(new ApiResponse(200, toStoryResponse(updated), "Story un-archived"));
});