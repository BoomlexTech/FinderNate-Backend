import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Report from "../models/report.models.js";
import Post from "../models/userPost.models.js";
import Story from "../models/story.models.js";
import Comment from "../models/comment.models.js";
import { User } from "../models/user.models.js";

/** Reports needed before content is queued for an admin to look at. */
const REPORT_ESCALATION_THRESHOLD = 3;

// Must include 'under_review' — that is the status reportContent escalates to
// once REPORT_ESCALATION_THRESHOLD reports exist. It was missing from both the
// list filter and the status-update whitelist, so the most-reported content on
// the platform disappeared from the 'pending' queue with no filter value that
// could select it, and a moderator could not put a report back into the review
// queue either. The value has always been in the model enum.
const REPORT_STATUSES = ['pending', 'under_review', 'reviewed', 'resolved', 'dismissed'];

export const reportContent = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) throw new ApiError(401, "Authentication required");

    const { type, contentId, reason, description } = req.body;

    if (!type) throw new ApiError(400, "Type is required");
    if (!contentId) throw new ApiError(400, "Content ID is required");
    if (!reason) throw new ApiError(400, "Reason is required");

    const validTypes = ['post', 'story', 'comment', 'user'];
    if (!validTypes.includes(type)) {
        throw new ApiError(400, `Type must be one of: ${validTypes.join(', ')}`);
    }

    const validReasons = ['spam', 'harassment', 'nudity', 'violence', 'hateSpeech', 'scam', 'childSafety', 'other'];
    if (!validReasons.includes(reason)) {
        throw new ApiError(400, `Reason must be one of: ${validReasons.join(', ')}`);
    }

    let content, reportData = {
        reporterId: userId,
        reason,
        description: description?.trim() || "",
        status: 'pending'
    };

    // Handle different content types
    if (type === 'post' || type === 'reel') {
        content = await Post.findById(contentId);
        if (!content) throw new ApiError(404, `${type.charAt(0).toUpperCase() + type.slice(1)} not found`);
        if (content.userId.toString() === userId.toString()) {
            throw new ApiError(400, `You cannot report your own ${type}`);
        }
        reportData.reportedPostId = contentId;
    }
    else if (type === 'story') {
        content = await Story.findById(contentId);
        if (!content) throw new ApiError(404, "Story not found");
        if (content.userId.toString() === userId.toString()) {
            throw new ApiError(400, "You cannot report your own story");
        }
        reportData.reportedStoryId = contentId;
    }
    else if (type === 'comment') {
        content = await Comment.findById(contentId);
        if (!content) throw new ApiError(404, "Comment not found");
        if (content.userId.toString() === userId.toString()) {
            throw new ApiError(400, "You cannot report your own comment");
        }
        reportData.reportedCommentId = contentId;
    }
    else if (type === 'user') {
        content = await User.findById(contentId);
        if (!content) throw new ApiError(404, "User not found");
        if (contentId.toString() === userId.toString()) {
            throw new ApiError(400, "You cannot report yourself");
        }
        reportData.reportedUserId = contentId;
    }

    // Ensure the same user can't report the same target twice
    const duplicateFilter = { reporterId: userId };
    if (reportData.reportedPostId) duplicateFilter.reportedPostId = reportData.reportedPostId;
    if (reportData.reportedCommentId) duplicateFilter.reportedCommentId = reportData.reportedCommentId;
    if (reportData.reportedStoryId) duplicateFilter.reportedStoryId = reportData.reportedStoryId;
    if (reportData.reportedUserId) duplicateFilter.reportedUserId = reportData.reportedUserId;

    const existing = await Report.findOne(duplicateFilter).lean();
    if (existing) {
        // Return 200 with existing report or 409 depending on preference; keep 409 but clearer message
        throw new ApiError(409, `You have already reported this ${type}`);
    }

    try {
        const report = await Report.create(reportData);

        // Check if content should be automatically deleted (after 3 reports)
        let reportCount = 0;
        let deleteFilter = {};

        if (type === 'post' || type === 'reel') {
            deleteFilter = { reportedPostId: contentId };
        } else if (type === 'story') {
            deleteFilter = { reportedStoryId: contentId };
        } else if (type === 'comment') {
            deleteFilter = { reportedCommentId: contentId };
        } else if (type === 'user') {
            deleteFilter = { reportedUserId: contentId };
        }

        // Count total reports for this content
        reportCount = await Report.countDocuments(deleteFilter);

        // Reports are ESCALATED for review, never auto-actioned.
        //
        // This used to hard-delete the content outright once three reports
        // existed: findByIdAndDelete, no ownership check, no admin involved, no
        // appeal, and none of the cleanup the real delete path performs (media
        // on Bunny, likes, comments, saved posts all left behind). Three
        // accounts — trivially three friends, or one person with three logins —
        // could permanently destroy anybody's post, and the author was never
        // told. Reporting is an accusation, not a verdict.
        //
        // The admin panel already reviews reports and offers view / delete /
        // keep, so the decision has a home. This only makes sure it reaches it.
        //
        // childSafety is the one exception to waiting for REPORT_ESCALATION_THRESHOLD:
        // a single CSAE report escalates immediately. Google's Child Safety
        // Standards policy expects these to reach a reviewer without waiting
        // for corroborating reports, which the content itself may never get.
        if (reportCount >= REPORT_ESCALATION_THRESHOLD || reason === 'childSafety') {
            await Report.updateMany(
                { ...deleteFilter, status: 'pending' },
                { status: 'under_review' }
            );

            // An escalated post is marked reported until a reviewer clears it, so a
            // post that is under review is not boosted or promoted in the meantime.
            // Only the escalation sets it: one report alone must not be able to
            // switch off somebody's boost.
            if (type === 'post' || type === 'reel') {
                await Post.updateOne({ _id: contentId }, { $set: { isReported: true, reportCount } });
            }
        }

        return res
            .status(201)
            .json(new ApiResponse(201, report, `${type.charAt(0).toUpperCase() + type.slice(1)} reported successfully`));
    } catch (error) {
        // Handle MongoDB duplicate key error (E11000)
        if (error.code === 11000) {
            throw new ApiError(409, `You have already reported this ${type}`);
        }
        throw error;
    }
});

// Keep the old function name for backward compatibility
export const reportPost = reportContent;

export const getReports = asyncHandler(async (req, res) => {
    const { reportId, status, page = 1, limit = 10 } = req.query;

    // If reportId is provided, return single report
    if (reportId) {
        const report = await Report.findById(reportId)
            .populate('reporterId', 'username fullName profilePicture')
            .populate('reportedPostId', 'caption media userId')
            .populate('reportedUserId', 'username fullName profilePicture')
            .populate('reportedCommentId', 'content userId')
            .populate('reportedStoryId', 'media userId');

        if (!report) throw new ApiError(404, "Report not found");

        return res
            .status(200)
            .json(new ApiResponse(200, report, "Report fetched successfully"));
    }

    // Otherwise return all reports with filters
    const filter = {};
    if (status && REPORT_STATUSES.includes(status)) {
        filter.status = status;
    }

    const reports = await Report.find(filter)
        .populate('reporterId', 'username fullName profilePicture')
        .populate('reportedPostId', 'caption media userId')
        .populate('reportedUserId', 'username fullName profilePicture')
        .populate('reportedCommentId', 'content userId')
        .populate('reportedStoryId', 'media userId')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalReports = await Report.countDocuments(filter);

    return res
        .status(200)
        .json(new ApiResponse(200, {
            reports,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalReports / limit),
                totalReports,
                hasNext: page < Math.ceil(totalReports / limit),
                hasPrev: page > 1
            }
        }, "Reports fetched successfully"));
});

export const updateReportStatus = asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const { status } = req.body;

    if (!reportId) throw new ApiError(400, "Report ID is required");
    if (!status) throw new ApiError(400, "Status is required");

    if (!REPORT_STATUSES.includes(status)) {
        throw new ApiError(400, `Status must be one of: ${REPORT_STATUSES.join(', ')}`);
    }

    const report = await Report.findById(reportId);
    if (!report) throw new ApiError(404, "Report not found");

    report.status = status;
    await report.save();

    return res
        .status(200)
        .json(new ApiResponse(200, report, "Report status updated successfully"));
});