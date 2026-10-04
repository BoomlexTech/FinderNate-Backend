import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Feedback from "../models/feedback.models.js";
import Business from "../models/business.models.js";
import { resolvePlanTier, TIER_NAMES } from "../utils/planLimits.js";
import { sendAdminAlert } from "../utils/adminAlert.utils.js";
import {
    FEEDBACK_STATUSES,
    FEEDBACK_PRIORITIES,
    FEEDBACK_CATEGORIES,
    priorityForTier,
    computeSlaDueAt,
    isFeedbackOverdue,
    buildStatusChange,
    statusQuery,
    splitCategoryPrefix
} from "../utils/supportQueue.utils.js";
import mongoose from "mongoose";

const formatIST = (date) =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(date);

// Tells the owner a paid customer has written in, so it is seen without anyone
// polling the admin panel. Best effort: it runs after the response has gone out
// and never throws.
// One alert email per account per hour. Every request is still saved and shows in
// the admin queue; only the email is rationed, so a burst from one account cannot
// flood the inbox. Per process, which is as precise as it needs to be.
const PRIORITY_ALERT_WINDOW_MS = 60 * 60 * 1000;
const lastPriorityAlertAt = new Map();

const shouldSendPriorityAlert = (userId, now = Date.now()) => {
    const key = String(userId);
    if (now - (lastPriorityAlertAt.get(key) || 0) < PRIORITY_ALERT_WINDOW_MS) return false;

    if (lastPriorityAlertAt.size > 5000) {
        for (const [id, at] of lastPriorityAlertAt) {
            if (now - at >= PRIORITY_ALERT_WINDOW_MS) lastPriorityAlertAt.delete(id);
        }
    }
    lastPriorityAlertAt.set(key, now);
    return true;
};

const alertPrioritySupportRequest = async (feedback, tier) => {
    try {
        const sender = feedback.userId;
        const replyBy = feedback.slaDueAt ? formatIST(feedback.slaDueAt) : null;

        let managerName = null;
        if (tier === 'corporate') {
            const business = await Business.findOne({ userId: sender?._id }).select('accountManager.name').lean();
            managerName = business?.accountManager?.name || 'Not assigned yet';
        }

        await sendAdminAlert({
            subject: `[${TIER_NAMES[tier]} support] ${sender?.fullName || 'A customer'} needs a reply`,
            title: `${TIER_NAMES[tier]} customer support request`,
            preheader: replyBy ? `Reply by ${replyBy} IST.` : '',
            intro: `A ${TIER_NAMES[tier]} subscriber sent a request from the in-app Help Center. It is ahead of standard requests in the queue.`,
            quote: feedback.message,
            details: [
                ['Plan', TIER_NAMES[tier]],
                ['From', sender ? `${sender.fullName} (@${sender.username})` : null],
                ['Email', sender?.email],
                ['Category', feedback.category],
                ['Reply by (IST)', replyBy],
                ...(tier === 'corporate' ? [['Account manager', managerName]] : [])
            ],
            footer: 'Reply from the support mailbox to the email above, then mark it responded under Admin > User Feedback.'
        });
    } catch (error) {
        console.error('Error sending support alert:', error?.message);
    }
};

// Submit feedback (User endpoint)
const submitFeedback = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    const { message } = req.body;

    // Validation
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new ApiError(400, "Message is required");
    }

    if (message.trim().length > 1000) {
        throw new ApiError(400, "Message must be less than 1000 characters");
    }

    try {
        // The plan is read here, on the server, so no client change is needed
        // for priority to apply and a client cannot claim one it has not paid for.
        const tier = await resolvePlanTier(userId);
        const { priority, priorityRank } = priorityForTier(tier);

        const parsed = splitCategoryPrefix(message.trim());
        const category = FEEDBACK_CATEGORIES.includes(req.body.category) ? req.body.category : parsed.category;

        const feedback = await Feedback.create({
            userId,
            message: parsed.message,
            category,
            status: 'open',
            planAtSubmit: tier,
            priority,
            priorityRank,
            slaDueAt: computeSlaDueAt(priority)
        });

        const populatedFeedback = await Feedback.findById(feedback._id)
            .populate('userId', 'username fullName email profileImageUrl');

        if (priorityRank > 0 && shouldSendPriorityAlert(feedback.userId)) {
            void alertPrioritySupportRequest(populatedFeedback, tier);
        }

        return res.status(201).json(
            new ApiResponse(
                201,
                { ...populatedFeedback.toObject(), expectedReplyBy: feedback.slaDueAt },
                "Feedback submitted successfully"
            )
        );
    } catch (error) {
        console.error('Error submitting feedback:', error);
        throw new ApiError(500, "Failed to submit feedback");
    }
});

// What the admin page needs per row: legacy rows (no status or priority) read
// as resolved and standard, the plan is the one the sender had when they wrote in.
const toAdminRow = (row, now, managerNameByUser = new Map()) => ({
    ...row,
    userId: row.userId || null,
    status: row.status || 'resolved',
    priority: row.priority || 'standard',
    planLabel: TIER_NAMES[row.planAtSubmit] || TIER_NAMES.free,
    overdue: isFeedbackOverdue(row, now),
    accountManagerName: managerNameByUser.get(String(row.userId?._id)) || null
});

// Get all feedback (Admin only)
const getAllFeedback = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const MAX_LIMIT = 100; // Prevent excessive data requests
    const requestedLimit = parseInt(req.query.limit) || 20;
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const skip = (page - 1) * limit;

    const { status, priority } = req.query;
    const filter = statusQuery(status);
    if (FEEDBACK_PRIORITIES.includes(priority)) {
        // Rows from before priority existed have no field and read as standard.
        filter.priority = priority === 'standard' ? { $in: ['standard', null] } : priority;
    }

    // The working queue is priority first, oldest first; the resolved tab is a
    // history, newest first.
    const sort = status === 'resolved' ? { createdAt: -1 } : { priorityRank: -1, createdAt: 1 };

    try {
        const now = new Date();

        const [rows, total, statusCounts, overdue] = await Promise.all([
            Feedback.find(filter)
                .populate('userId', 'username fullName email profileImageUrl')
                .sort(sort)
                .limit(limit)
                .skip(skip)
                .lean(),
            Feedback.countDocuments(filter),
            Feedback.aggregate([{ $group: { _id: { $ifNull: ['$status', 'resolved'] }, count: { $sum: 1 } } }]),
            Feedback.countDocuments({
                status: { $in: ['open', 'in_progress'] },
                firstResponseAt: null,
                slaDueAt: { $lt: now }
            })
        ]);

        const counts = { open: 0, in_progress: 0, resolved: 0, overdue };
        for (const { _id, count } of statusCounts) {
            if (FEEDBACK_STATUSES.includes(_id)) counts[_id] = count;
        }

        // A Corporate request shows its manager, so they can pick out their clients.
        const corporateUserIds = rows
            .filter((row) => row.planAtSubmit === 'corporate' && row.userId?._id)
            .map((row) => row.userId._id);
        const managerNameByUser = new Map();
        if (corporateUserIds.length > 0) {
            const businesses = await Business.find({ userId: { $in: corporateUserIds } })
                .select('userId accountManager.name')
                .lean();
            for (const business of businesses) {
                if (business.accountManager?.name) {
                    managerNameByUser.set(String(business.userId), business.accountManager.name);
                }
            }
        }

        return res.status(200).json(
            new ApiResponse(200, {
                feedback: rows.map((row) => toAdminRow(row, now, managerNameByUser)),
                counts,
                pagination: {
                    currentPage: page,
                    totalPages: Math.ceil(total / limit),
                    totalItems: total,
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            }, "All feedback retrieved successfully")
        );
    } catch (error) {
        console.error('Error retrieving all feedback:', error);
        throw new ApiError(500, "Failed to retrieve feedback");
    }
});

// Update a request's status and internal note (Admin only)
const updateFeedbackStatus = asyncHandler(async (req, res) => {
    const { feedbackId } = req.params;
    const { status, adminNote } = req.body;

    if (!mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback ID");
    }

    if (!FEEDBACK_STATUSES.includes(status)) {
        throw new ApiError(400, `Status must be one of: ${FEEDBACK_STATUSES.join(', ')}`);
    }

    if (adminNote !== undefined && (typeof adminNote !== 'string' || adminNote.trim().length > 500)) {
        throw new ApiError(400, "Note must be 500 characters or fewer");
    }

    const current = await Feedback.findById(feedbackId).select('status firstResponseAt resolvedAt').lean();
    if (!current) {
        throw new ApiError(404, "Feedback not found");
    }

    const { set, unset } = buildStatusChange(current, status);
    set.handledBy = req.admin._id;
    if (adminNote !== undefined) {
        set.adminNote = adminNote.trim();
    }

    const update = { $set: set };
    if (Object.keys(unset).length > 0) {
        update.$unset = unset;
    }

    const updated = await Feedback.findByIdAndUpdate(feedbackId, update, { new: true, runValidators: true })
        .populate('userId', 'username fullName email profileImageUrl')
        .lean();

    if (!updated) {
        throw new ApiError(404, "Feedback not found");
    }

    await req.admin.logActivity(
        'feedback_status_update',
        'feedback',
        feedbackId,
        `Support request from ${updated.userId?.username ? `@${updated.userId.username}` : 'a deleted user'} moved to ${status}`
    );

    return res.status(200).json(
        new ApiResponse(200, toAdminRow(updated, new Date()), "Feedback updated successfully")
    );
});

// Delete feedback (Admin only)
const deleteFeedback = asyncHandler(async (req, res) => {
    const { feedbackId } = req.params;

    if (!mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback ID");
    }

    try {
        const feedback = await Feedback.findByIdAndDelete(feedbackId);

        if (!feedback) {
            throw new ApiError(404, "Feedback not found");
        }

        return res.status(200).json(
            new ApiResponse(200, { deletedId: feedbackId }, "Feedback deleted successfully")
        );
    } catch (error) {
        console.error('Error deleting feedback:', error);
        throw new ApiError(500, "Failed to delete feedback");
    }
});

export {
    submitFeedback,
    getAllFeedback,
    updateFeedbackStatus,
    deleteFeedback
};
