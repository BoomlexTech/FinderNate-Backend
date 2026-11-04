import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import ProfileVisit from '../models/profileVisit.models.js';
import { User } from '../models/user.models.js';
import Block from '../models/block.models.js';

/**
 * Profile visitors (Phase 2 #65).
 *
 * A visit is recorded when a signed-in account opens someone else's profile,
 * unless the visitor hides their visits. Hiding is reciprocal: an account that
 * hides its visits can't see its own visitors.
 */

/** Whether a visit should be stored. Pure. */
export const shouldRecordVisit = ({ visitorId, profileUserId, visitorHidesVisits }) =>
    !!visitorId && !!profileUserId && String(visitorId) !== String(profileUserId) && !visitorHidesVisits;

/** Record a visit. Best-effort, never throws. */
export const recordProfileVisit = async (visitorId, profileUserId) => {
    try {
        if (!visitorId || String(visitorId) === String(profileUserId)) return;
        const visitor = await User.findById(visitorId).select('profileVisitsHidden').lean();
        if (!shouldRecordVisit({ visitorId, profileUserId, visitorHidesVisits: visitor?.profileVisitsHidden === true })) return;
        await ProfileVisit.updateOne(
            { profileUserId, visitorId },
            { $set: { lastVisitedAt: new Date() }, $inc: { visitCount: 1 } },
            { upsert: true },
        );
        // Phase 4 #75: views for verified businesses.
        const { recordBusinessView } = await import('./businessGrowth.controllers.js');
        recordBusinessView(profileUserId, 'profile', visitorId);
    } catch { /* a visitor log must never break opening a profile */ }
};

/** GET /users/me/profile-visitors?page&limit */
export const getProfileVisitors = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const me = await User.findById(userId).select('profileVisitsHidden').lean();
    if (me?.profileVisitsHidden) {
        return res.status(200).json(new ApiResponse(200, {
            visitors: [],
            hidden: true,
            pagination: { page: 1, limit: 0, total: 0, totalPages: 0 },
        }, 'Turn on "Show my profile visits" to see who visited you'));
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));

    const blocks = await Block.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).select('blockerId blockedId').lean();
    const blockedIds = blocks.map((b) => (String(b.blockerId) === String(userId) ? b.blockedId : b.blockerId));
    const filter = { profileUserId: userId, ...(blockedIds.length ? { visitorId: { $nin: blockedIds } } : {}) };

    const [visits, total] = await Promise.all([
        ProfileVisit.find(filter).sort({ lastVisitedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        ProfileVisit.countDocuments(filter),
    ]);
    const users = await User.find({
        _id: { $in: visits.map((v) => v.visitorId) },
        isDeleted: { $ne: true },
        accountStatus: 'active',
        // Someone who started hiding visits after visiting drops off the list.
        profileVisitsHidden: { $ne: true },
    }).select('username fullName profileImageUrl').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return res.status(200).json(new ApiResponse(200, {
        visitors: visits
            .map((v) => ({ user: byId.get(String(v.visitorId)), lastVisitedAt: v.lastVisitedAt, visitCount: v.visitCount }))
            .filter((v) => v.user),
        hidden: false,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Profile visitors fetched'));
});
