import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import Report from "../../models/report.models.js";
import Feedback from "../../models/feedback.models.js";
import { UNASSIGNED_MANAGER_FILTER } from "../../utils/accountManager.utils.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// GET /api/v1/admin/dashboard/stats
export const getDashboardStats = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.viewAnalytics) {
        throw new ApiError(403, "Insufficient permissions to view analytics");
    }

    const [
        totalUsers,
        totalBusinesses,
        totalReports,
        pendingReports,
        pendingAadhaarVerifications,
        pendingBusinessVerifications,
        activeUsers,
        verifiedBusinesses,
        openSupportRequests,
        corporateAwaitingManager
    ] = await Promise.all([
        // Soft-deleted accounts are excluded. Nothing else in the platform
        // treats an isDeleted user as a user — the auth guard rejects them and
        // the socket handshake refuses them — so counting them here inflates
        // the headline number the dashboard reports as "total users".
        User.countDocuments({ isDeleted: { $ne: true } }),
        Business.countDocuments(),
        Report.countDocuments(),
        Report.countDocuments({ status: 'pending' }),
        Business.countDocuments({
            $or: [
                { 'documents': { $elemMatch: { documentType: 'aadhaar', verified: false } } },
                // `$nin: [null, ""]`, NOT `{ $ne: null, $ne: "" }`.
                //
                // That was a JavaScript object literal with a DUPLICATE KEY:
                // the second `$ne` silently overwrites the first, so only the
                // `""` check survived and the null check never ran at all. A
                // business whose aadhaarNumber is explicitly null then matched
                // `$exists: true` and got queued as awaiting Aadhaar
                // verification despite having submitted no Aadhaar. There are
                // already 2 such businesses; they escape this count today only
                // because they happen to be verified.
                { aadhaarNumber: { $exists: true, $nin: [null, ""] }, isVerified: false }
            ]
        }),
        Business.countDocuments({
            $or: [
                { verificationStatus: 'pending' },
                { 'documents': { $elemMatch: { verified: false, documentType: { $ne: 'aadhaar' } } } }
            ]
        }),
        // Same exclusion as totalUsers — a deleted account is not an active one,
        // and without this activeUsers could exceed the total it is a subset of.
        User.countDocuments({ accountStatus: 'active', isDeleted: { $ne: true } }),
        Business.countDocuments({ isVerified: true }),
        // Support requests still waiting for a first reply.
        Feedback.countDocuments({ status: 'open' }),
        // Corporate subscribers nobody has been assigned to yet.
        Business.countDocuments({ plan: 'plan3', ...UNASSIGNED_MANAGER_FILTER })
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [newUsers, newBusinesses, newReports] = await Promise.all([
        User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
        Business.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
        Report.countDocuments({ createdAt: { $gte: thirtyDaysAgo } })
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            overview: {
                totalUsers,
                totalBusinesses,
                totalReports,
                activeUsers,
                verifiedBusinesses
            },
            pending: {
                reports: pendingReports,
                aadhaarVerifications: pendingAadhaarVerifications,
                businessVerifications: pendingBusinessVerifications,
                support: openSupportRequests,
                corporateAwaitingManager
            },
            recent: {
                newUsers,
                newBusinesses,
                newReports
            }
        }, "Dashboard stats fetched successfully")
    );
});

// GET /api/v1/admin/activity-log
export const getAdminActivityLog = asyncHandler(async (req, res) => {
    const { page = 1, limit = 50 } = req.query;

    const activities = req.admin.activityLog
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice((page - 1) * limit, page * limit);

    return res.status(200).json(
        new ApiResponse(200, {
            activities,
            pagination: {
                currentPage: parseInt(page),
                totalActivities: req.admin.activityLog.length,
                hasNext: page * limit < req.admin.activityLog.length,
                hasPrev: page > 1
            }
        }, "Activity log fetched successfully")
    );
});
