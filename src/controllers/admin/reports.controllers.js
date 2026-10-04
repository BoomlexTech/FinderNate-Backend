import Report from "../../models/report.models.js";
import Post from "../../models/userPost.models.js";
import Story from "../../models/story.models.js";
import Comment from "../../models/comment.models.js";
import Like from "../../models/like.models.js";
import SavedPost from "../../models/savedPost.models.js";
import PostInteraction from "../../models/postInteraction.models.js";
import { User } from "../../models/user.models.js";
import { invalidateAuthCache } from "../../middlewares/auth.middleware.js";
import { deleteFromBunny, deleteMultipleFromBunny } from "../../utils/bunny.js";
import { invalidatePostCaches } from "../post/helpers.js";
import { cancelBoostsForPost } from "../../utils/boostServing.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { notifyStatusChange } from "./helpers.js";

// Statuses a report can be listed by or moved to. 'under_review' is set by the
// escalation in report.controllers.js once enough complaints accumulate; it was
// missing from both lists, so the most-reported content dropped out of the
// Pending queue and could not be filtered for or set back by hand.
const REPORT_STATUSES = ['pending', 'under_review', 'reviewed', 'resolved', 'dismissed'];

// GET /api/v1/admin/reports
export const getAllReports = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status, reason, type } = req.query;

    let filter = {};

    if (status && REPORT_STATUSES.includes(status)) {
        filter.status = status;
    }

    if (reason && ['spam', 'harassment', 'nudity', 'violence', 'hateSpeech', 'scam', 'other'].includes(reason)) {
        filter.reason = reason;
    }

    if (type) {
        if (type === 'post') filter.reportedPostId = { $exists: true, $ne: null };
        else if (type === 'user') filter.reportedUserId = { $exists: true, $ne: null };
        else if (type === 'comment') filter.reportedCommentId = { $exists: true, $ne: null };
        else if (type === 'story') filter.reportedStoryId = { $exists: true, $ne: null };
    }

    // The author of reported content is populated one level deeper than the
    // content itself. Without it a comment/post/story report showed only the
    // reporter, so a moderator could delete the content but had no idea whose
    // it was and no way to act on the account behind it. accountStatus comes
    // along so the panel can show "already banned" instead of offering the
    // action again.
    const AUTHOR_FIELDS = 'username fullName profileImageUrl accountStatus';

    const reports = await Report.find(filter)
        .populate('reporterId', 'username fullName profileImageUrl')
        .populate('reportedUserId', 'username fullName profileImageUrl accountStatus')
        // postType is what separates a photo from a Vibe (reel/video) from a
        // tweet — they all live in the Post collection, so without it the panel
        // can only say "Post" and a moderator cannot tell what they are about
        // to remove.
        .populate({
            path: 'reportedPostId',
            select: 'caption media userId contentType postType',
            populate: { path: 'userId', select: AUTHOR_FIELDS },
        })
        .populate({
            path: 'reportedCommentId',
            select: 'content userId',
            populate: { path: 'userId', select: AUTHOR_FIELDS },
        })
        .populate({
            path: 'reportedStoryId',
            select: 'media userId',
            populate: { path: 'userId', select: AUTHOR_FIELDS },
        })
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalReports = await Report.countDocuments(filter);

    const stats = await Report.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);

    const reportStats = REPORT_STATUSES.reduce((acc, key) => {
        acc[key] = 0;
        return acc;
    }, {});

    stats.forEach(stat => {
        reportStats[stat._id] = stat.count;
    });

    return res.status(200).json(
        new ApiResponse(200, {
            reports,
            stats: reportStats,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalReports / limit),
                totalReports,
                hasNext: page < Math.ceil(totalReports / limit),
                hasPrev: page > 1
            }
        }, "Reports fetched successfully")
    );
});

// A moderation takedown has to do what the author's own delete does
// (controllers/post/delete.controllers.js): drop the media from Bunny, unlink
// the post from its author, clear the rows that point at it and invalidate the
// caches. Deleting the row alone left the media publicly retrievable at its CDN
// URL and left the cached copies — including fn:share:preview:<id>, which
// serves an already-shared link to logged-out visitors — still handing it out.
//
// Reports are deliberately NOT deleted here: this handler is in the middle of
// resolving one, and the report is the record of the takedown.
const takeDownPost = async (post) => {
    const mediaUrls = [];
    (post.media || []).forEach(media => {
        if (media.url) mediaUrls.push(media.url);
        if (media.thumbnailUrl) mediaUrls.push(media.thumbnailUrl);
        (media.additionalMedia || []).forEach(additionalMedia => {
            if (additionalMedia.url) mediaUrls.push(additionalMedia.url);
            if (additionalMedia.thumbnailUrl) mediaUrls.push(additionalMedia.thumbnailUrl);
        });
    });

    // Row first, then the media: failing on Bunny leaves orphaned files, which
    // is recoverable, while the reverse leaves a live post pointing at files
    // that no longer exist.
    await Post.findByIdAndDelete(post._id);
    await User.findByIdAndUpdate(post.userId, { $pull: { posts: post._id } });
    await cancelBoostsForPost(post._id).catch((error) =>
        console.error("Could not cancel boosts for a removed post:", error));

    if (mediaUrls.length > 0) {
        try {
            await deleteMultipleFromBunny(mediaUrls);
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
        }
    }

    await Promise.allSettled([
        Like.deleteMany({ postId: post._id }),
        Comment.deleteMany({ postId: post._id }),
        SavedPost.deleteMany({ postId: post._id }),
        PostInteraction.deleteMany({ postId: post._id }),
    ]);

    await invalidatePostCaches(post._id.toString(), post.userId);
};

const takeDownStory = async (story) => {
    await Story.findByIdAndDelete(story._id);

    if (story.mediaUrl) {
        try {
            await deleteFromBunny(story.mediaUrl);
        } catch (error) {
            console.error("Bunny.net deletion error:", error);
        }
    }

    await invalidatePostCaches(story._id.toString(), story.userId);
};

/**
 * The account a ban/suspend should land on for a given report.
 *
 * Only a 'user' report carries reportedUserId. A comment, post or story report
 * identifies the offending account solely through the content's own author, so
 * ban_user used to be silently skipped for all three: the report was still
 * marked resolved and the activity log still recorded "action: ban_user", while
 * nothing at all happened to the account. A moderator had no way to see that.
 *
 * Returns an id or null. Content already deleted by a prior action yields null,
 * which the caller reports rather than swallowing.
 */
const resolveOffendingUserId = (report) => {
    if (report.reportedUserId) return report.reportedUserId._id ?? report.reportedUserId;

    const authored = report.reportedCommentId
        ?? report.reportedPostId
        ?? report.reportedStoryId;
    if (!authored?.userId) return null;

    // userId is populated to a document by getAllReports but is a bare
    // ObjectId when the doc is loaded here, so accept both shapes.
    return authored.userId._id ?? authored.userId;
};

// PUT /api/v1/admin/reports/:reportId/status
export const updateReportStatus = asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const { status, action, remarks } = req.body;

    if (!REPORT_STATUSES.includes(status)) {
        throw new ApiError(400, "Invalid status");
    }

    // The route is gated on manageReports only. Taking content down and banning
    // an account are separate permissions on the Admin schema, and a super
    // admin who created a triage-only moderator without them recorded an
    // explicit intent that this account cannot do either — reaching them
    // through the reports screen bypassed that.
    if (status === 'resolved') {
        if (action === 'delete_content' && !req.admin.permissions.deleteContent) {
            throw new ApiError(403, "Insufficient permissions: deleteContent required");
        }
        if ((action === 'ban_user' || action === 'suspend_user') && !req.admin.permissions.banUsers) {
            throw new ApiError(403, "Insufficient permissions: banUsers required");
        }
    }

    const report = await Report.findById(reportId)
        .populate('reportedPostId')
        .populate('reportedUserId')
        .populate('reportedCommentId')
        .populate('reportedStoryId');

    if (!report) {
        throw new ApiError(404, "Report not found");
    }

    report.status = status;
    report.adminRemarks = remarks;
    report.reviewedBy = req.admin._id;
    report.reviewedAt = new Date();

    if (action && status === 'resolved') {
        if (action === 'delete_content') {
            if (report.reportedPostId) {
                await takeDownPost(report.reportedPostId);
            } else if (report.reportedCommentId) {
                await Comment.findByIdAndDelete(report.reportedCommentId._id);
            } else if (report.reportedStoryId) {
                await takeDownStory(report.reportedStoryId);
            }
        } else if (action === 'ban_user' || action === 'suspend_user') {
            const targetUserId = resolveOffendingUserId(report);

            // Fail loudly. Marking the report resolved while the account went
            // untouched is how a moderator ends up believing a ban was applied.
            if (!targetUserId) {
                throw new ApiError(
                    400,
                    "Cannot action the account for this report: the reported content and its author are no longer available."
                );
            }

            const accountStatus = action === 'ban_user' ? 'banned' : 'deactivated';
            await User.findByIdAndUpdate(targetUserId, { accountStatus });
            await invalidateAuthCache(targetUserId);
            await notifyStatusChange(targetUserId.toString(), accountStatus);
        }
    }

    await report.save();

    // Once no report on the post is still waiting for a reviewer, it is no longer
    // "reported" for boost and promotion purposes.
    const reviewedPostId = report.reportedPostId?._id;
    if (reviewedPostId && ![pending, under_review].includes(status)) {
        const stillOpen = await Report.exists({
            reportedPostId: reviewedPostId,
            status: { $in: [pending, under_review] }
        });
        if (!stillOpen) {
            await Post.updateOne({ _id: reviewedPostId }, { $set: { isReported: false } });
        }
    }

    await req.admin.logActivity(
        `report_${status}`,
        'report',
        reportId,
        `Report ${status} with action: ${action || 'none'}. Remarks: ${remarks || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, report, "Report status updated successfully")
    );
});

// DELETE /api/v1/admin/reports/:reportId
export const deleteReport = asyncHandler(async (req, res) => {
    const { reportId } = req.params;

    const report = await Report.findByIdAndDelete(reportId);
    if (!report) {
        throw new ApiError(404, "Report not found");
    }

    await req.admin.logActivity(
        'report_deleted',
        'report',
        reportId,
        'Report permanently deleted'
    );

    return res.status(200).json(
        new ApiResponse(200, {}, "Report deleted successfully")
    );
});
