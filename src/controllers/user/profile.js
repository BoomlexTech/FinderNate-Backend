import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { uploadBufferToBunny } from "../../utils/bunny.js";
import mongoose from "mongoose";
import Business from "../../models/business.models.js";
import Post from "../../models/userPost.models.js";
import FollowRequest from "../../models/followRequest.models.js";
import Reel from "../../models/reels.models.js";
import Comment from "../../models/comment.models.js";
import Like from "../../models/like.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import Story from "../../models/story.models.js";
import Draft from "../../models/draft.models.js";
import SavedPost from "../../models/savedPost.models.js";
import SearchHistory from "../../models/searchHistory.models.js";
import PostInteraction from "../../models/postInteraction.models.js";
import Subscription from "../../models/subscription.models.js";
import PushSubscription from "../../models/pushSubscription.models.js";
import Chat from "../../models/chat.models.js";
import Message from "../../models/message.models.js";
import Activity from "../../models/activity.models.js";
import Notification from "../../models/notification.models.js";
import Report from "../../models/report.models.js";
import Feedback from "../../models/feedback.models.js";
import ContactRequest from "../../models/contactRequest.models.js";
import Block from "../../models/block.models.js";
import Follower from "../../models/follower.models.js";
import Following from "../../models/following.models.js";
import Media from "../../models/mediaUser.models.js";
import { validateUsername } from "../../utils/usernameSuggestions.js";
import { getFollowStatus } from "../../utils/followEngagement.utils.js";
import { assertValidPassword } from "./_helpers.js";

const getUserProfile = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    const userIdStr = userId.toString();

    const { RedisKeys, RedisTTL } = await import('../../config/redis.config.js');
    const { CacheManager } = await import('../../utils/cache.utils.js');
    const { getFollowersCount, getFollowingCount } = await import('../../utils/followEngagement.utils.js');

    const profileCacheKey = RedisKeys.userProfile(userIdStr);
    const cachedProfile = await CacheManager.get(profileCacheKey);

    const [followersCount, followingCount, postsCount] = await Promise.all([
        getFollowersCount(userIdStr),
        getFollowingCount(userIdStr),
        Post.countDocuments({ userId }),
    ]);

    /**
     * The settings a user can change from a switch are read LIVE on every
     * request, never from the cached snapshot.
     *
     * The snapshot lives for an hour, and the endpoints that flip these live
     * elsewhere — Service/Product posts in the business controller, hide
     * phone/address in privacy.js, autofill in preferences.js. Every one of
     * them that forgot to invalidate this key produced the same symptom: the
     * write succeeded, the next profile read returned the OLD value, and the
     * switch snapped back on its own. Both clients ended up carrying local
     * "re-assert the toggle result" workarounds for it.
     *
     * Rather than depend on every current and future writer remembering to
     * invalidate, these fields simply are not cached. They are three indexed
     * reads on a request that already makes several.
     */
    const readLiveSettings = async () => {
        const settingsUser = await User.findById(userId)
            .select('isBusinessProfile isPhoneNumberHidden isAddressHidden phoneNumber address isPhoneVerified privacy isFullPrivate messagingPrivacy servicePostPreferences productPostPreferences')
            .lean();

        if (!settingsUser) return null;

        let businessInfo = null;
        if (settingsUser.isBusinessProfile) {
            businessInfo = await Business.findOne({ userId })
                .select('postSettings isVerified subscriptionStatus plan')
                .lean();
        }

        const isContentVisible = settingsUser.isBusinessProfile && businessInfo
            ? businessInfo.subscriptionStatus === 'active' && businessInfo.plan !== 'plan1'
            : true;

        return {
            // The OWNER always sees their own phone number and address.
            //
            // These were nulled out whenever the hide flag was on, but the
            // flag means "hide this from OTHER people" — getOtherUserProfile
            // is where it is enforced. Applying it here meant that turning on
            // "Hide phone number" made the user's own settings screen report
            // the number as Not Set, which reads as the number having been
            // wiped rather than hidden.
            phoneNumber: settingsUser.phoneNumber ?? null,
            address: settingsUser.address ?? null,
            isPhoneVerified: settingsUser.isPhoneVerified,
            isPhoneNumberHidden: settingsUser.isPhoneNumberHidden,
            isAddressHidden: settingsUser.isAddressHidden,
            privacy: settingsUser.privacy,
            isFullPrivate: settingsUser.isFullPrivate,
            // Returned so the client can paint the saved state instead of the
            // 'everyone' default — Account Settings had no other source for it
            // and always showed the default, whatever had been chosen.
            messagingPrivacy: {
                onlineStatus: settingsUser.messagingPrivacy?.onlineStatus || 'everyone',
                lastSeen: settingsUser.messagingPrivacy?.lastSeen || 'everyone',
            },
            servicePostAutoFill: settingsUser.servicePostPreferences?.enableAutoFill ?? true,
            productPostAutoFill: settingsUser.productPostPreferences?.enableAutoFill ?? true,
            productEnabled: settingsUser.isBusinessProfile ? (businessInfo?.postSettings?.allowProductPosts ?? true) : null,
            serviceEnabled: settingsUser.isBusinessProfile ? (businessInfo?.postSettings?.allowServicePosts ?? true) : null,
            isVerified: settingsUser.isBusinessProfile ? (businessInfo?.isVerified ?? false) : null,
            isContentVisible: settingsUser.isBusinessProfile ? isContentVisible : true,
            contentVisibilityMessage: settingsUser.isBusinessProfile && !isContentVisible
                ? 'Your product, service and business listings are not promoted until you upgrade.'
                : null,
        };
    };

    if (cachedProfile) {
        const liveSettings = await readLiveSettings();
        if (liveSettings) {
            return res.status(200).json(
                new ApiResponse(200, {
                    ...cachedProfile,
                    ...liveSettings,
                    followersCount,
                    followingCount,
                    postsCount,
                }, "User profile retrieved successfully")
            );
        }
    }

    const user = await User.findById(userId).select(
        "username fullName email phoneNumber address gender dateOfBirth bio profileImageUrl location link followers following posts isBusinessProfile businessProfileId isBlueTickVerified isEmailVerified isPhoneVerified isPhoneNumberHidden isAddressHidden privacy isFullPrivate messagingPrivacy servicePostPreferences productPostPreferences createdAt"
    );

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const subscriptionBadge = await user.getSubscriptionBadge();

    // Only the STABLE half of the profile is cached; everything a settings
    // switch can change is spread in fresh from readLiveSettings below.
    const profileSnapshot = {
        _id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        isBusinessProfile: user.isBusinessProfile,
        businessProfileId: user.businessProfileId,
        isBlueTickVerified: user.isBlueTickVerified,
        isEmailVerified: user.isEmailVerified,
        subscriptionBadge,
        createdAt: user.createdAt,
        bio: user.bio,
        link: user.link,
        location: user.location,
        profileImageUrl: user.profileImageUrl,
    };

    await CacheManager.set(profileCacheKey, profileSnapshot, RedisTTL.USER_PROFILE);

    const liveSettings = (await readLiveSettings()) || {};

    return res.status(200).json(
        new ApiResponse(200, {
            ...profileSnapshot,
            ...liveSettings,
            followersCount,
            followingCount,
            postsCount,
        }, "User profile retrieved successfully")
    );
});

/**
 * The ONLY fields PUT /users/profile may write.
 *
 * This used to spread the whole request body into a $set and filter it with a
 * denylist, so every schema field the denylist forgot went straight into the
 * document: isBlueTickVerified (the blue tick, which only the admin route
 * PUT /admin/users/:userId/blue-tick is meant to set), isBusinessProfile and
 * businessProfileId (paid business gating), isDeleted, privacy/isFullPrivate —
 * and accountStatus, which the denylist misspelled as "acccoutStatus", so a
 * user could ban themselves. Everything not listed here is either server-owned
 * or has its own checked route: privacy toggles (/privacy/*), phone and email
 * changes (OTP flows), messaging privacy, chat wallpaper, autofill preferences.
 */
const EDITABLE_PROFILE_FIELDS = [
    "fullName",
    "username",
    "bio",
    "location",
    "link",
    "profileImageUrl",
    "gender",
    "dateOfBirth",
    "address"
];

// Anything else in the body is dropped silently, but these keep the explicit
// 400 the endpoint has always returned so a client trying to change a
// credential is told why it did not happen instead of seeing a silent no-op.
const PROTECTED_PROFILE_FIELDS = [
    "email",
    "password",
    "refreshToken",
    "isEmailVerified",
    "isPhoneVerified",
    "accountStatus",
    "followers",
    "following",
    "posts",
    "uid"
];

const updateUserProfile = asyncHandler(async (req, res) => {
    for (const field of PROTECTED_PROFILE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            throw new ApiError(400, `Field '${field}' cannot be updated`);
        }
    }

    const updates = {};
    for (const field of EDITABLE_PROFILE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
            updates[field] = req.body[field];
        }
    }

    if (updates.fullName) {
        updates.fullNameLower = updates.fullName.toLowerCase();
    }

    if (updates.username !== undefined) {
        const cleaned = updates.username.trim().toLowerCase();
        const { isValid, errors } = validateUsername(cleaned);
        if (!isValid) {
            throw new ApiError(400, errors[0], errors.map(e => ({ field: "username", message: e })));
        }
        const taken = await User.findOne({ username: cleaned, _id: { $ne: req.user._id } }).select("_id");
        if (taken) {
            throw new ApiError(409, "Username is already taken", [{ field: "username", message: "Username is already taken" }]);
        }
        updates.username = cleaned;
    }

    if (req.file) {
        const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");
        if (!uploadResult || !uploadResult.secure_url) {
            throw new ApiError(500, "Failed to upload image to Bunny.net");
        }
        updates.profileImageUrl = uploadResult.secure_url;
    }

    if (Object.keys(updates).length === 0) {
        throw new ApiError(400, "No updatable profile fields provided");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updates },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken ");

    const { invalidateAuthCache } = await import('../../middlewares/auth.middleware.js');
    await invalidateAuthCache(req.user._id);

    const { UserCacheManager } = await import('../../utils/cache.utils.js');
    await UserCacheManager.invalidateUserProfile(req.user._id);

    if (updates.username || updates.profileImageUrl || updates.fullName) {
        const { updateUserInLikedByHashes } = await import('../../utils/postEngagement.utils.js');
        updateUserInLikedByHashes(req.user._id, {
            username: updatedUser.username,
            fullName: updatedUser.fullName,
            profileImageUrl: updatedUser.profileImageUrl,
        }).catch(() => {});
    }

    return res
        .status(200)
        .json(new ApiResponse(200, updatedUser, "User profile updated successfully"));
});

const uploadProfileImage = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new ApiError(400, "Profile Image is required");
    }

    const userId = req.user._id;
    const uploadResult = await uploadBufferToBunny(req.file.buffer, "profiles");

    if (!uploadResult || !uploadResult.secure_url) {
        throw new ApiError(500, "Failed to upload image to Bunny.net");
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { profileImageUrl: uploadResult.secure_url },
        { new: true, runValidators: true }
    ).select("username fullName profileImageUrl");

    return res
        .status(200)
        .json(new ApiResponse(200, user, "profile image uploaded successfully"));
});

const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        throw new ApiError(400, "Current password and new password are required");
    }

    //* save() below DOES run validators, but minlength alone would allow a
    //* 200-character password; this applies the same 8-20 policy as signup
    //* and reset so the rule lives in one place.
    assertValidPassword(newPassword);

    const user = await User.findById(req.user._id);
    const isMatch = await user.isPasswordCorrect(currentPassword);

    if (!isMatch) {
        throw new ApiError(401, "current Password is incorrect");
    }

    user.password = newPassword;
    await user.save();

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password changed Successfully"));
});

const getOtherUserProfile = asyncHandler(async (req, res) => {
    const { identifier } = req.query;
    const blockedUsers = req.blockedUsers || [];

    if (!identifier) {
        throw new ApiError(400, "User identifier (userId or username) is required");
    }

    let targetUser;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
        targetUser = await User.findById(identifier).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    if (!targetUser) {
        targetUser = await User.findOne({ username: identifier.toLowerCase() }).select('-password -refreshToken -emailVerificationToken -emailOTP -emailOTPExpiry -passwordResetOTP -passwordResetOTPExpiry -phoneVerificationCode -phoneVerificationExpiry');
    }

    if (!targetUser) {
        throw new ApiError(404, "User not found");
    }

    if (blockedUsers.includes(targetUser._id.toString())) {
        throw new ApiError(403, "Cannot access this profile due to blocking");
    }

    const isFollowing = await getFollowStatus(req.user._id, targetUser._id);

    const pendingRequest = await FollowRequest.findOne({
        requesterId: req.user._id,
        recipientId: targetUser._id,
        status: 'pending'
    });

    const { getFollowersCount, getFollowingCount } = await import('../../utils/followEngagement.utils.js');
    const targetIdStr = targetUser._id.toString();
    const [followersCount, followingCount, postsCount] = await Promise.all([
        getFollowersCount(targetIdStr),
        getFollowingCount(targetIdStr),
        Post.countDocuments({ userId: targetUser._id }),
    ]);

    let businessId = null;
    let isContentVisible = true;
    if (targetUser.isBusinessProfile) {
        const business = await Business.findOne({ userId: targetUser._id }).select('postSettings isVerified subscriptionStatus plan');
        if (business) {
            businessId = business._id;
            isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';
        }
    }

    const subscriptionBadge = await targetUser.getSubscriptionBadge();

    const userWithCounts = {
        _id: targetUser._id,
        username: targetUser.username,
        fullName: targetUser.fullName,
        phoneNumber: targetUser.isPhoneNumberHidden ? null : (targetUser.phoneNumber || ""),
        address: targetUser.isAddressHidden ? null : (targetUser.address || ""),
        dateOfBirth: targetUser.dateOfBirth || "",
        gender: targetUser.gender || "",
        isBusinessProfile: targetUser.isBusinessProfile,
        businessId: businessId,
        isEmailVerified: targetUser.isEmailVerified,
        isPhoneVerified: targetUser.isPhoneVerified,
        isContentVisible: targetUser.isBusinessProfile ? isContentVisible : true,
        contentVisibilityMessage: targetUser.isBusinessProfile && !isContentVisible
            ? 'Product, service and business listings are not promoted until this business upgrades.'
            : null,
        subscriptionBadge: subscriptionBadge,
        bio: targetUser.bio || "",
        link: targetUser.link || "",
        location: targetUser.location || "",
        profileImageUrl: targetUser.profileImageUrl || "",
        followersCount,
        followingCount,
        postsCount,
        // Private by EITHER flag. `privacy` alone left an account carrying
        // isFullPrivate:true advertising itself as public to the client, which
        // then rendered the full profile instead of the locked one.
        isPrivate: targetUser.privacy === 'private' || targetUser.isFullPrivate === true,
        isFullPrivate: targetUser.isFullPrivate === true,
        createdAt: targetUser.createdAt
    };

    const responseData = {
        _id: targetUser._id,
        isFollowedBy: isFollowing,
        isPending: !!pendingRequest,
        userId: userWithCounts
    };

    return res.status(200).json(
        new ApiResponse(200, responseData, "User profile retrieved successfully")
    );
});

const deleteAccount = asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
        throw new ApiError(400, "Password is required to delete your account");
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    const isMatch = await user.isPasswordCorrect(password);
    if (!isMatch) {
        throw new ApiError(401, "Password is incorrect");
    }

    const userId = user._id;

    let mediaCleanup = { deleted: 0, failed: 0, errors: [] };
    try {
        const userMedia = await Media.find({ uploadedBy: userId });
        for (const media of userMedia) {
            try {
                const { deleteFromBunny } = await import("../../utils/bunny.js");
                await deleteFromBunny(media.url);
                mediaCleanup.deleted++;
            } catch (err) {
                mediaCleanup.failed++;
                mediaCleanup.errors.push({ mediaId: media._id, error: err.message });
            }
        }
        await Media.deleteMany({ uploadedBy: userId });
    } catch (err) {
        mediaCleanup.errors.push({ error: 'Failed to clean up media', details: err.message });
    }

    // Captured BEFORE the cleanup below pulls this user out of them, so the
    // follow-up pass can still find the conversations they were part of.
    const userChats = await Chat.find({ participants: userId }).select("_id").lean();
    const userChatIds = userChats.map(chat => chat._id);

    const cleanupResults = await Promise.allSettled([
        Post.deleteMany({ userId }),
        Reel.deleteMany({ userId }),
        Comment.deleteMany({ userId }),
        Like.deleteMany({ userId }),
        Business.deleteOne({ userId }),
        BusinessRating.deleteMany({ userId }),
        Story.deleteMany({ userId }),
        Draft.deleteMany({ userId }),
        SavedPost.deleteMany({ userId }),
        SearchHistory.deleteMany({ userId }),
        PostInteraction.deleteMany({ userId }),
        Subscription.deleteMany({ userId }),
        Subscription.deleteMany({ subscriberId: userId }),
        PushSubscription.deleteMany({ userId }),
        // The Device model is gone: nothing in the codebase ever created a
        // Device row, so this cleared an always-empty collection while the
        // schema stood as a ready-made landing zone for ipAddress/browser/os.
        // A Chat is the SHARED record of a conversation, not a per-user copy.
        // This was Chat.deleteMany({ participants: userId }), which hard-deleted
        // every thread the leaving user was in — so the person on the other side
        // lost their own messages, the packing photos and the agreed price they
        // would need to defend an escrow dispute. Only this user's participation
        // is removed; the counterparty keeps the conversation.
        Chat.updateMany(
            { participants: userId },
            {
                $pull: {
                    participants: userId,
                    admins: userId,
                    mutedBy: userId,
                    blockedUsers: userId
                }
            }
        ),
        // The field on MessageSchema is `sender`; `senderId` does not exist, so
        // this matched nothing and the departing user's message bodies, media
        // urls and file names were all retained despite the erasure promise.
        Message.deleteMany({ sender: userId }),
        Activity.deleteMany({ userId }),
        // Four more of the same class of bug as the two documented above: these
        // filtered on field names that do not exist on their schemas, so every
        // one of them matched nothing and silently deleted zero rows while the
        // erasure reported success. Verified against the models:
        //   Activity       -> targetId    (was targetUserId)
        //   Notification   -> receiverId  (was userId)
        //   FollowRequest  -> requesterId / recipientId  (was from / to)
        //   ContactRequest -> requester / businessOwner  (was userId / contactUserId)
        // The ContactRequest rows are the sharpest of these: they carry the
        // phone number the user shared, and they were being served to the other
        // party after the account was gone.
        Activity.deleteMany({ targetId: userId }),
        Notification.deleteMany({ receiverId: userId }),
        Notification.deleteMany({ senderId: userId }),
        Report.deleteMany({ reporterId: userId }),
        Feedback.deleteMany({ userId }),
        FollowRequest.deleteMany({ requesterId: userId }),
        FollowRequest.deleteMany({ recipientId: userId }),
        ContactRequest.deleteMany({ requester: userId }),
        ContactRequest.deleteMany({ businessOwner: userId }),
        Block.deleteMany({ blockerId: userId }),
        // Same class of bug as the message cleanup above: the field on
        // BlockSchema is `blockedId`, so blocks placed ON this user were never
        // cleared and outlived the account.
        Block.deleteMany({ blockedId: userId }),
        User.updateMany({ followers: userId }, { $pull: { followers: userId } }),
        User.updateMany({ following: userId }, { $pull: { following: userId } }),
        Post.updateMany({ mentions: userId }, { $pull: { mentions: userId } }),
        Like.deleteMany({ postId: { $in: user.posts || [] } }),
        Comment.deleteMany({ postId: { $in: user.posts || [] } }),
        Follower.deleteMany({ userId }),
        Follower.deleteMany({ followerId: userId }),
        Following.deleteMany({ userId }),
        Following.deleteMany({ followingId: userId })
    ]);

    if (userChatIds.length) {
        try {
            // A conversation nobody is left in (the other side had already
            // deleted their account) is dead weight — that one can go, together
            // with whatever messages remain in it.
            const emptyChats = await Chat.find({
                _id: { $in: userChatIds },
                participants: { $size: 0 }
            }).select("_id").lean();

            if (emptyChats.length) {
                const emptyChatIds = emptyChats.map(chat => chat._id);
                await Promise.allSettled([
                    Message.deleteMany({ chatId: { $in: emptyChatIds } }),
                    Chat.deleteMany({ _id: { $in: emptyChatIds } })
                ]);
            }

            // The chat list renders chat.lastMessage. Where that was one of the
            // messages just deleted, roll it back to the newest surviving one so
            // the other participant isn't left looking at text that no longer
            // exists.
            const staleChats = await Chat.find({
                _id: { $in: userChatIds },
                "lastMessage.sender": userId
            }).select("_id").lean();

            for (const chat of staleChats) {
                const latest = await Message.findOne({
                    chatId: chat._id,
                    isDeleted: { $ne: true }
                })
                    .sort({ timestamp: -1 })
                    .select("sender message timestamp")
                    .lean();

                await Chat.updateOne(
                    { _id: chat._id },
                    latest
                        ? {
                            $set: {
                                lastMessageId: latest._id,
                                lastMessage: {
                                    sender: latest.sender,
                                    message: latest.message,
                                    timestamp: latest.timestamp
                                },
                                lastMessageAt: latest.timestamp
                            }
                        }
                        : { $unset: { lastMessageId: "", lastMessage: "" } }
                );
            }
        } catch (err) {
            // Best effort: the account itself must still be deleted.
            console.error("[deleteAccount] chat cleanup failed:", err?.message || err);
        }
    }

    await User.findByIdAndDelete(userId);

    return res
        .status(200)
        .clearCookie("accessToken")
        .clearCookie("refreshToken")
        .json(
            new ApiResponse(
                200,
                {
                    message: "Account and all associated data deleted successfully",
                    mediaCleanup,
                    cleanupResults: cleanupResults.map((result, index) => ({
                        operation: [
                            "posts", "reels", "comments", "likes", "business", "business_ratings",
                            "stories", "drafts", "products", "cart", "wishlist", "orders",
                            "saved_posts", "search_history", "post_interactions",
                            "subscriptions_user", "subscriptions_subscriber", "push_subscriptions",
                            "payments", "chats", "messages", "activities_user",
                            "activities_target", "notifications_user", "notifications_sender",
                            "reports", "feedback", "follow_requests_from", "follow_requests_to",
                            "contact_requests_user", "contact_requests_contact", "blocks_blocker",
                            "blocks_blocked", "followers_cleanup", "following_cleanup",
                            "mentions_cleanup", "post_likes_cleanup", "post_comments_cleanup",
                            "follower_records", "follower_records_reverse", "following_records",
                            "following_records_reverse", "cart_products_cleanup", "wishlist_products_cleanup"
                        ][index],
                        status: result.status,
                        ...(result.status === 'rejected' && { error: result.reason?.message })
                    }))
                },
                "Account deleted Successfully"
            )
        );
});

export {
    getUserProfile,
    updateUserProfile,
    uploadProfileImage,
    changePassword,
    getOtherUserProfile,
    deleteAccount,
};
