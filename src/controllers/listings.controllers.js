import mongoose from 'mongoose';
import PaidListing from '../models/paidListing.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { listingChecks, withGst } from '../utils/phase4.rules.js';
import { verificationConfigured } from '../services/cashfreeVerify.service.js';
import { gstPercent } from './platformPayments.controllers.js';

/**
 * One-time product post for regular users (Phase 4 #80):
 * Aadhaar check → automatic listing checks (flagged ones go to admins, Q15)
 * → pay → visible to everyone for 30 or 60 days → expires.
 */

const fees = async () => ({
    30: Number(await getSettingValue('LISTING_FEE_30', null)) || null,
    60: Number(await getSettingValue('LISTING_FEE_60', null)) || null,
});

/** GET /listings/config */
export const listingConfig = asyncHandler(async (req, res) => {
    const f = await fees();
    const user = await User.findById(req.user._id).select('aadhaarVerification isBusinessProfile').lean();
    return res.status(200).json(new ApiResponse(200, {
        available: !!(f[30] || f[60]),
        fees: f,
        gstPercent: await gstPercent(),
        aadhaarVerified: user?.aadhaarVerification?.status === 'verified',
        aadhaarCheckAvailable: verificationConfigured(),
        forBusinesses: false,
        isBusiness: !!user?.isBusinessProfile,
    }, 'OK'));
});

/** POST /listings  { postId, days: 30|60 } */
export const createListing = asyncHandler(async (req, res) => {
    const { postId } = req.body || {};
    const days = Number(req.body?.days);
    if (![30, 60].includes(days)) throw new ApiError(400, 'Choose 30 or 60 days');
    if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Choose one of your product posts');
    const f = await fees();
    if (!f[days]) throw new ApiError(409, 'Listings are coming soon');

    const user = await User.findById(req.user._id).select('aadhaarVerification isBusinessProfile').lean();
    if (user?.isBusinessProfile) throw new ApiError(409, 'Business accounts reach everyone with a plan instead');
    if (user?.aadhaarVerification?.status !== 'verified') {
        const err = new ApiError(403, 'Verify your Aadhaar first');
        err.data = { code: 'AADHAAR_REQUIRED' };
        throw err;
    }
    const post = await Post.findOne({ _id: postId, userId: req.user._id }).lean();
    if (!post) throw new ApiError(404, 'Post not found');
    const live = await PaidListing.findOne({ postId, status: { $in: ['flagged', 'awaiting_payment', 'active'] } }).lean();
    if (live) throw new ApiError(409, live.status === 'active' ? 'This post is already listed' : 'This post already has a listing in progress');

    const flags = listingChecks(post);
    const price = withGst(f[days], await gstPercent());
    const listing = await PaidListing.create({
        userId: req.user._id, postId, days,
        amount: price.amount, gstPercent: price.gstPercent, gst: price.gst, total: price.total,
        status: flags.length ? 'flagged' : 'awaiting_payment', flags,
    });
    return res.status(201).json(new ApiResponse(201, listing, flags.length
        ? 'We need to check this listing first. You will be notified.'
        : 'Ready to pay'));
});

/** GET /listings/mine */
export const myListings = asyncHandler(async (req, res) => {
    const rows = await PaidListing.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).populate('postId', 'caption media customization contentType').lean();
    return res.status(200).json(new ApiResponse(200, { listings: rows }, 'OK'));
});

/** DELETE /listings/:id — cancel before paying. */
export const cancelListing = asyncHandler(async (req, res) => {
    const r = await PaidListing.updateOne({ _id: req.params.id, userId: req.user._id, status: { $in: ['flagged', 'awaiting_payment'] } }, { $set: { status: 'cancelled' } });
    if (!r.modifiedCount) throw new ApiError(409, 'Only unpaid listings can be cancelled');
    return res.status(200).json(new ApiResponse(200, { cancelled: true }, 'Cancelled'));
});

/** Hourly: active listings past their end date expire; owners are told. */
export const runListingExpiry = async () => {
    const due = await PaidListing.find({ status: 'active', endsAt: { $lte: new Date() } }).limit(500).lean();
    for (const l of due) {
        await PaidListing.updateOne({ _id: l._id }, { $set: { status: 'expired' } });
        await notifyActivity({ recipientId: l.userId, type: 'listing', postId: l.postId, message: 'Your listing has ended. Renew it to show it to everyone again.', data: { listingId: String(l._id) } });
    }
};

/** GET /admin/listings?status=flagged */
export const adminListings = asyncHandler(async (req, res) => {
    const rows = await PaidListing.find({ status: String(req.query.status || 'flagged') })
        .sort({ createdAt: 1 }).limit(200)
        .populate('postId', 'caption description media customization contentType')
        .populate('userId', 'username fullName aadhaarVerification.status').lean();
    return res.status(200).json(new ApiResponse(200, { listings: rows }, 'OK'));
});

/** POST /admin/listings/:id/decision  { decision: 'approve'|'reject', note } */
export const adminListingDecision = asyncHandler(async (req, res) => {
    const listing = await PaidListing.findOne({ _id: req.params.id, status: 'flagged' });
    if (!listing) throw new ApiError(404, 'No flagged listing with that id');
    const approve = req.body?.decision === 'approve';
    listing.status = approve ? 'awaiting_payment' : 'rejected';
    listing.reviewedBy = req.admin?._id;
    listing.reviewNote = String(req.body?.note || '').slice(0, 300);
    await listing.save();
    await notifyActivity({
        recipientId: listing.userId, type: 'listing', postId: listing.postId,
        message: approve ? 'Your listing was approved. Pay to make it visible to everyone.' : `Your listing was not approved${listing.reviewNote ? `: ${listing.reviewNote}` : '.'}`,
        data: { listingId: String(listing._id) },
    });
    return res.status(200).json(new ApiResponse(200, { status: listing.status }, 'Saved'));
});
