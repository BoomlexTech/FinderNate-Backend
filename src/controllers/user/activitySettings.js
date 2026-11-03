import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { User } from '../../models/user.models.js';
import ProfileVisit from '../../models/profileVisit.models.js';
import { forgetHistoryPause } from '../postInteraction.controllers.js';

/**
 * Phase 2 privacy and activity settings, read and written together:
 *   mentionPrivacy       everyone | following | nobody   (#64)
 *   historyPaused        boolean                          (#14)
 *   profileVisitsHidden  boolean                          (#65)
 *   emailNotifications   { activity, messages }: digest | off (#10)
 */
const FIELDS = 'mentionPrivacy historyPaused profileVisitsHidden emailNotifications preferredCategories';

const shape = (u) => ({
    mentionPrivacy: u?.mentionPrivacy || 'everyone',
    historyPaused: u?.historyPaused === true,
    profileVisitsHidden: u?.profileVisitsHidden === true,
    emailNotifications: {
        activity: u?.emailNotifications?.activity || 'digest',
        messages: u?.emailNotifications?.messages || 'digest',
    },
    preferredCategories: u?.preferredCategories || [],
});

/** Validated $set for a PATCH body. Pure; throws ApiError on bad values. */
export const activitySettingsUpdate = (body = {}) => {
    const $set = {};
    if (body.mentionPrivacy !== undefined) {
        if (!['everyone', 'following', 'nobody'].includes(body.mentionPrivacy)) throw new ApiError(400, 'mentionPrivacy must be everyone, following or nobody');
        $set.mentionPrivacy = body.mentionPrivacy;
    }
    for (const key of ['historyPaused', 'profileVisitsHidden']) {
        if (body[key] !== undefined) {
            if (typeof body[key] !== 'boolean') throw new ApiError(400, `${key} must be true or false`);
            $set[key] = body[key];
        }
    }
    const email = body.emailNotifications;
    if (email !== undefined) {
        if (!email || typeof email !== 'object') throw new ApiError(400, 'emailNotifications must be an object');
        for (const key of ['activity', 'messages']) {
            if (email[key] === undefined) continue;
            if (!['digest', 'off'].includes(email[key])) throw new ApiError(400, `emailNotifications.${key} must be digest or off`);
            $set[`emailNotifications.${key}`] = email[key];
        }
    }
    return $set;
};

/** GET /users/me/activity-settings */
export const getActivitySettings = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select(FIELDS).lean();
    return res.status(200).json(new ApiResponse(200, shape(user), 'Settings fetched'));
});

/** PATCH /users/me/activity-settings */
export const updateActivitySettings = asyncHandler(async (req, res) => {
    const $set = activitySettingsUpdate(req.body);
    if (!Object.keys($set).length) throw new ApiError(400, 'Nothing to change');
    const user = await User.findByIdAndUpdate(req.user._id, { $set }, { new: true }).select(FIELDS).lean();
    if ('historyPaused' in $set) forgetHistoryPause(req.user._id);
    // Hiding your visits also removes the visits you already left.
    if ($set.profileVisitsHidden === true) await ProfileVisit.deleteMany({ visitorId: req.user._id });
    return res.status(200).json(new ApiResponse(200, shape(user), 'Settings saved'));
});
