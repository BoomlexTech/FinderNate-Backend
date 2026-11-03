import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Post from "../../models/userPost.models.js";
import Reel from "../../models/reels.models.js";
import Story from "../../models/story.models.js";

/**
 * Drops the caches a settings change has to outlive.
 *
 * GET /users/profile serves a Redis snapshot with a ONE HOUR TTL, and none of
 * the toggles below used to invalidate it. The write landed in Mongo every
 * time, then the very next profile read handed back the pre-toggle snapshot —
 * so "Hide Phone" and "Hide Address" appeared not to save at all, and both
 * clients ended up carrying local workarounds for it. The auth cache holds its
 * own copy of the user for req.user, so it goes too.
 */
const invalidateProfileCaches = async (userId) => {
    const [{ invalidateAuthCache }, { UserCacheManager }] = await Promise.all([
        import('../../middlewares/auth.middleware.js'),
        import('../../utils/cache.utils.js'),
    ]);

    await Promise.allSettled([
        invalidateAuthCache(userId),
        UserCacheManager.invalidateUserProfile(userId.toString()),
    ]);
};

const togglePhoneNumberVisibility = asyncHandler(async (req, res) => {
    const { isHidden } = req.body;

    if (typeof isHidden !== 'boolean') {
        throw new ApiError(400, "isHidden must be a boolean value");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { isPhoneNumberHidden: isHidden },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken");

    if (!updatedUser) {
        throw new ApiError(404, "User not found");
    }

    await invalidateProfileCaches(req.user._id);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                isPhoneNumberHidden: updatedUser.isPhoneNumberHidden,
                phoneNumber: updatedUser.isPhoneNumberHidden ? null : updatedUser.phoneNumber
            },
            `Phone number ${isHidden ? 'hidden' : 'visible'} successfully`
        )
    );
});

const toggleAddressVisibility = asyncHandler(async (req, res) => {
    const { isHidden } = req.body;

    if (typeof isHidden !== 'boolean') {
        throw new ApiError(400, "isHidden must be a boolean value");
    }

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { isAddressHidden: isHidden },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -emailVerificationToken");

    if (!updatedUser) {
        throw new ApiError(404, "User not found");
    }

    await invalidateProfileCaches(req.user._id);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                isAddressHidden: updatedUser.isAddressHidden,
                address: updatedUser.isAddressHidden ? null : updatedUser.address,
                // The same switch hides the profile's location line (#12).
                location: updatedUser.isAddressHidden ? null : (updatedUser.location || "")
            },
            `Address ${isHidden ? 'hidden' : 'visible'} successfully`
        )
    );
});

const toggleFullPrivateAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    // An explicit target wins over a blind flip.
    //
    // A flip-only endpoint desynchronises the moment a request is retried or
    // the switch is tapped twice: the client sends "make me private" and gets
    // back whatever the opposite of the server's state happened to be. Both
    // spellings the clients use are accepted; omitting them keeps the old
    // toggle behaviour so nothing already deployed breaks.
    const body = req.body || {};
    const requested = typeof body.isFullPrivate === 'boolean'
        ? body.isFullPrivate
        : typeof body.isPrivate === 'boolean'
            ? body.isPrivate
            : typeof body.privacy === 'string'
                ? body.privacy === 'private'
                : null;

    try {
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        // Private by EITHER flag, so an account where the two disagree
        // resolves to the safe reading rather than flipping to public.
        const currentlyPrivate = user.privacy === "private" || user.isFullPrivate === true;
        const newFullPrivateState = requested === null ? !currentlyPrivate : requested;
        const newPrivacyState = newFullPrivateState ? "private" : "public";

        user.privacy = newPrivacyState;
        user.isFullPrivate = newFullPrivateState;

        // Account privacy is NOT stamped onto individual posts.
        //
        // This used to write settings.privacy onto every Post, Reel and Story
        // the user owned, which broke private accounts in both directions:
        //
        //  - Going private marked every post "private", and the feeds exclude
        //    private posts from EVERYONE with `'settings.privacy': {$ne:
        //    'private'}`. So a private account's followers — the people who are
        //    supposed to see it — saw nothing. "Nobody can see it."
        //
        //  - Going public again reset every post to "public", silently undoing
        //    any post the user had deliberately made private one at a time.
        //
        // The two settings mean different things and are enforced in different
        // places. Account privacy is decided by getViewableUserIds, which
        // already resolves to "followers + own + all public accounts" for a
        // signed-in viewer and "public accounts only" for an anonymous one.
        // settings.privacy stays what it says on the tin: this one post is
        // private, whatever the account is.
        await user.save();

        const { invalidateAuthCache } = await import('../../middlewares/auth.middleware.js');
        await invalidateAuthCache(userId);

        const { UserCacheManager, FeedCacheManager, CacheManager } = await import('../../utils/cache.utils.js');
        await UserCacheManager.invalidateUserProfile(userId);
        await FeedCacheManager.invalidateUserFeed(userId);

        const { invalidateViewableUsersCache } = await import('../../middlewares/privacy.middleware.js');
        await invalidateViewableUsersCache(userId);

        // Going PRIVATE has to purge OTHER people's caches, not just this
        // user's.
        //
        // Only the "went public" case was handled, so switching an account to
        // private left its posts sitting in every viewer's already-cached home
        // feed (fn:user:<id>:feed:*), in explore and in trending until those
        // expired — the account read as private everywhere except the one
        // place people actually look, which is exactly the "other users can
        // still see the posts" report. Both directions now clear all three.
        await Promise.allSettled([
            CacheManager.delPattern('fn:user:*:feed:*'),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed(),
        ]);

        return res.status(200).json(
            new ApiResponse(200, {
                privacy: user.privacy,
                isPrivate: user.privacy === "private",
                isFullPrivate: user.isFullPrivate,
                message: newFullPrivateState
                    ? "Account is now private - all content is private"
                    : "Account is now public - all content is public"
            }, `Account privacy ${newFullPrivateState ? 'enabled' : 'disabled'}`)
        );
    } catch (error) {
        throw new ApiError(500, "Error toggling account privacy", [error.message]);
    }
});

const updateMessagingPrivacy = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const body = req.body || {};

    const validSettings = ['everyone', 'followers', 'nobody'];

    // Messaging privacy is set THROUGH THIS ROUTE, not through the profile.
    //
    // PUT /users/profile now writes a strict allow-list of editable fields
    // and messagingPrivacy is deliberately not on it, so a client still
    // posting it there has it dropped in silence. This is the endpoint that
    // does the work, and it accepts the shapes the clients actually send:
    // { onlineStatus, lastSeen } for the two settings individually, or a
    // single value under `visibility`/`messagingPrivacy`/`privacy` when the
    // screen offers one control and moves both together.
    const single = [body.visibility, body.messagingPrivacy, body.privacy]
        .find(value => typeof value === 'string' && value.trim());

    const onlineStatus = body.onlineStatus || single;
    const lastSeen = body.lastSeen || single;

    if (onlineStatus && !validSettings.includes(onlineStatus)) {
        throw new ApiError(400, 'Invalid onlineStatus setting. Must be: everyone, followers, or nobody');
    }

    if (lastSeen && !validSettings.includes(lastSeen)) {
        throw new ApiError(400, 'Invalid lastSeen setting. Must be: everyone, followers, or nobody');
    }

    const updateFields = {};
    if (onlineStatus) {
        updateFields['messagingPrivacy.onlineStatus'] = onlineStatus;
    }
    if (lastSeen) {
        updateFields['messagingPrivacy.lastSeen'] = lastSeen;
    }

    if (Object.keys(updateFields).length === 0) {
        throw new ApiError(400, 'At least one privacy setting must be provided');
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: updateFields },
        { new: true, runValidators: true }
    ).select('messagingPrivacy');

    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // GET /users/profile now reports messagingPrivacy too, and it is served
    // from a one-hour snapshot — without this the settings screen could read
    // back the pre-change value.
    await invalidateProfileCaches(userId);

    const updatedOnlineStatus = user.messagingPrivacy?.onlineStatus || 'everyone';
    const updatedLastSeen = user.messagingPrivacy?.lastSeen || 'everyone';
    const canSeeOthersStatus = updatedOnlineStatus !== 'nobody' && updatedLastSeen !== 'nobody';

    return res.status(200).json(
        new ApiResponse(200, {
            privacy: {
                onlineStatus: updatedOnlineStatus,
                lastSeen: updatedLastSeen,
                canSeeOthersStatus
            }
        }, 'Messaging privacy settings updated successfully')
    );
});

const getMessagingPrivacy = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId).select('messagingPrivacy');

    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    const onlineStatus = user.messagingPrivacy?.onlineStatus || 'everyone';
    const lastSeen = user.messagingPrivacy?.lastSeen || 'everyone';
    const canSeeOthersStatus = onlineStatus !== 'nobody' && lastSeen !== 'nobody';

    const privacy = { onlineStatus, lastSeen, canSeeOthersStatus };

    return res.status(200).json(
        new ApiResponse(200, { privacy }, 'Messaging privacy settings retrieved successfully')
    );
});

export {
    togglePhoneNumberVisibility,
    toggleAddressVisibility,
    toggleFullPrivateAccount,
    updateMessagingPrivacy,
    getMessagingPrivacy,
};
