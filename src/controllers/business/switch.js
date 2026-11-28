import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import mongoose from "mongoose";

// GET /users/profile serves a Redis-cached snapshot (1h TTL); without this,
// clients re-fetching the profile right after a switch read the old
// isBusinessProfile and flip back.
const invalidateProfileCache = async (userId) => {
    const { UserCacheManager } = await import("../../utils/cache.utils.js");
    await UserCacheManager.invalidateUserProfile(userId.toString());
};

/**
 * Both contact channels must be verified before an account becomes a business.
 *
 * A business account sells to strangers, so both ways of reaching its owner
 * have to be proven first: the email address AND the mobile number. Sign-up
 * proves only one of them (the channel the code was sent to); the other is
 * verified from Settings.
 *
 * Asked only while the account is still personal, i.e. when business mode is
 * being turned ON. An account that is already a business is left alone, so
 * nobody is locked out of a business they are running today.
 *
 * The error carries `VERIFICATION_REQUIRED` with what is missing, so the app
 * and the website can send the person straight to the right verify screen.
 * `errors` is an OBJECT, like the other feature gates (CALLING_FEATURE_
 * RESTRICTED, POST_LIMIT_REACHED): the app reads a 403 whose `errors` is a
 * LIST as the legal re-acceptance gate.
 */
export const assertContactsVerifiedForBusiness = (user) => {
    if (!user || user.isBusinessProfile) return;

    const emailVerified = user.isEmailVerified === true;
    const phoneVerified = user.isPhoneVerified === true;
    if (emailVerified && phoneVerified) return;

    const missing = !emailVerified && !phoneVerified
        ? "email address and mobile number"
        : !emailVerified ? "email address" : "mobile number";

    throw new ApiError(403, `Verify your ${missing} before switching to a business account.`, {
        errorCode: "VERIFICATION_REQUIRED",
        emailVerified,
        phoneVerified
    });
};

// POST /api/v1/users/switch-to-business
export const switchTobusinessprofile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    assertContactsVerifiedForBusiness(user);

    let business = await Business.findOne({ userId });

    if (business) {
        if (!user.isBusinessProfile) {
            user.isBusinessProfile = true;
            user.businessProfileId = business._id;
            await user.save();
            await invalidateProfileCache(userId);
        }

        const businessObj = business.toObject();
        if (businessObj.rating !== undefined) {
            delete businessObj.rating;
        }

        return res.status(200).json(
            new ApiResponse(200, {
                alreadyBusiness: true,
                businessProfile: businessObj,
                businessId: business._id,
                message: user.isBusinessProfile ? "Already on business profile" : "Switched to existing business profile"
            }, "Switched to business profile")
        );
    }

    // No Business document yet — the user has turned business mode ON but has
    // not filled in the business profile.
    //
    // businessProfileId stays NULL here. It used to be set to a freshly minted
    // ObjectId that pointed at nothing, so the account claimed a business
    // profile that did not exist and nothing downstream could tell "not set up
    // yet" from "set up but missing". Null says exactly what is true.
    //
    // `needsProfileSetup` is returned so the client can send the user straight
    // to the business form. Without it the switch looks like it succeeded and
    // the first sign anything is missing is a red error when they try to pay.
    user.isBusinessProfile = true;
    user.businessProfileId = null;
    await user.save();
    await invalidateProfileCache(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            alreadyBusiness: false,
            businessProfile: null,
            businessId: null,
            needsProfileSetup: true,
            message: "Switched to business account mode. Create your business profile to get started."
        }, "Switched to business account mode")
    );
});

// POST /api/v1/business/switch-to-personal
export const switchToPersonalAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    if (!user.isBusinessProfile) {
        throw new ApiError(400, "User is already on a personal account");
    }

    user.isBusinessProfile = false;
    await user.save();
    await invalidateProfileCache(userId);

    return res.status(200).json(
        new ApiResponse(200, {
            isBusinessProfile: false,
            message: "Successfully switched to personal account"
        }, "Switched to personal account successfully")
    );
});
