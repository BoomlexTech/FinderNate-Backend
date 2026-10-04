import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getCoordinates } from "../../utils/getCoordinates.js";
import mongoose from "mongoose";
import { BUSINESS_CATEGORIES, extractTagsFromText } from "./helpers.js";
import { cancelBoostsForPost } from "../../utils/boostServing.js";

// Canonical forms of the two statutory identity numbers: GSTIN is 15 uppercase
// alphanumerics, Aadhaar is 12 digits, and neither contains a space.
//
// Used for BOTH the incoming value and the STORED one. Rows written before this
// validation existed hold whatever the client happened to send — the website
// posts Aadhaar back in its grouped display form ("XXXX XXXX XXXX"), the app
// stored GST exactly as typed — so a raw comparison against a freshly
// normalised value reports an unchanged number as changed, which silently
// revokes the admin's KYC approval. Normalising both sides makes the first save
// after this deploy repair the stored value instead.
const normaliseGst = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();
const normaliseAadhaar = (value) => String(value ?? '').replace(/\s+/g, '');

// POST /api/v1/business/create
export const createBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    let existingBusiness = await Business.findOne({ userId });

    if (existingBusiness && existingBusiness.isProfileCompleted) {
        throw new ApiError(409, "Business profile already exists. Please use the update endpoint to modify your business details.");
    }

    const {
        businessName,
        businessType,
        description,
        category,
        subcategory,
        contact,
        location,
        tags,
        website,
        gstNumber,
        aadhaarNumber
    } = req.body;

    // `rating` is deliberately NOT read from the body. It used to be, on both
    // branches below, and BusinessSchema puts no bounds on it — so a brand new
    // seller could post {"rating": 5} (or 99) about themselves and have it
    // served to buyers by searchAllContent/searchSuggestion, which select the
    // stored field directly. The only number that belongs here is the average
    // recomputed from real BusinessRating rows in ./rating.js.

    if (category && !BUSINESS_CATEGORIES.includes(category)) {
        throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
    }

    const trimmedBusinessName = businessName ? businessName.trim() : '';
    const normalizedCategory = category ? category.trim() : '';
    const normalizedSubcategory = subcategory ? subcategory.trim() : '';

    if (contact && contact.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contact.email)) {
            throw new ApiError(400, "Invalid contact.email format");
        }
    }

    if (website && !/^https?:\/\/.+/.test(website)) {
        throw new ApiError(400, "Invalid website URL");
    }
    if (contact && contact.website && !/^https?:\/\/.+/.test(contact.website)) {
        throw new ApiError(400, "Invalid contact.website URL");
    }

    if (trimmedBusinessName) {
        const existingBusinessByName = await Business.findOne({ businessName: trimmedBusinessName });
        if (existingBusinessByName) {
            throw new ApiError(409, "Business name already in use");
        }
    }

    // A GSTIN is exactly 15 uppercase alphanumerics; an Aadhaar number is
    // exactly 12 digits. Neither contains a space.
    //
    // The only check here used to be `gstNumber.length < 15`, which is a floor
    // and not a format: "22AAAAA0000A1Z5 COPIED FROM CERTIFICATE" satisfies it,
    // and so does 60 characters of anything. Both clients let that through
    // because neither constrained the field, and the value ends up in front of
    // an admin who reads it off the verification screen and acts on it — so a
    // malformed number that LOOKS plausible is the failure that matters.
    //
    // Normalised before the uniqueness check, not after: the same GSTIN typed
    // with a trailing space or in lower case used to miss the existing-row
    // lookup entirely and register a second time.
    let normalisedGst = '';
    if (typeof gstNumber === 'string' && gstNumber.trim() !== '') {
        normalisedGst = normaliseGst(gstNumber);
        if (!/^[0-9A-Z]{15}$/.test(normalisedGst)) {
            throw new ApiError(400, "GST number must be exactly 15 letters or digits, with no spaces");
        }
        const existingGST = await Business.findOne({ gstNumber: normalisedGst });
        if (existingGST) {
            throw new ApiError(409, "GST number already registered");
        }
    }

    let normalisedAadhaar = '';
    if (typeof aadhaarNumber === 'string' && aadhaarNumber.trim() !== '') {
        // Spaces stripped because both clients display Aadhaar grouped as
        // "XXXX XXXX XXXX" and the website posts back what it renders.
        normalisedAadhaar = normaliseAadhaar(aadhaarNumber);
        if (!/^\d{12}$/.test(normalisedAadhaar)) {
            throw new ApiError(400, "Aadhaar number must be exactly 12 digits, with no spaces");
        }
    }

    let finalTags = [];
    if (tags && Array.isArray(tags) && tags.length > 0) {
        finalTags = tags
            .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
            .map(tag => tag.toLowerCase().trim());

        if (finalTags.length === 0) {
            throw new ApiError(400, "Tags must be non-empty strings");
        }
    } else {
        const autoTags = extractTagsFromText(trimmedBusinessName, description, normalizedCategory, normalizedSubcategory);
        finalTags = autoTags.map(tag => tag.toLowerCase());
    }

    const uniqueTags = [...new Set(finalTags)];

    let resolvedLocation = location || {};
    if (location && (location.address || location.city)) {
        const locationString = [location.address, location.city, location.state, location.country]
            .filter(Boolean)
            .join(', ');

        if (locationString) {
            try {
                const coords = await getCoordinates(locationString);
                if (coords?.latitude && coords?.longitude) {
                    resolvedLocation.coordinates = {
                        type: "Point",
                        coordinates: [coords.longitude, coords.latitude]
                    };
                    resolvedLocation.isLiveLocationEnabled = true;
                    resolvedLocation.lastLocationUpdate = new Date();
                }
            } catch (error) {
                // Continue without coordinates if resolution fails
            }
        }
    }

    let business;

    if (existingBusiness) {
        existingBusiness.businessName = trimmedBusinessName;
        if (businessType) existingBusiness.businessType = businessType;
        if (description) existingBusiness.description = description;
        if (normalizedCategory) existingBusiness.category = normalizedCategory;
        if (normalizedSubcategory) existingBusiness.subcategory = normalizedSubcategory;
        if (contact) existingBusiness.contact = contact;
        if (resolvedLocation) existingBusiness.location = resolvedLocation;
        existingBusiness.tags = uniqueTags;
        if (website) existingBusiness.website = website;

        // The NORMALISED values, not the raw body: what was validated above is
        // what gets stored, so the row can never hold a spaced or lower-case
        // variant that the uniqueness check would then fail to match.
        if (normalisedGst) existingBusiness.gstNumber = normalisedGst;
        if (normalisedAadhaar) existingBusiness.aadhaarNumber = normalisedAadhaar;

        existingBusiness.isProfileCompleted = true;
        await existingBusiness.save();
        business = existingBusiness;
    } else {
        const Subscription = (await import('../../models/subscription.models.js')).default;
        const userSubscription = await Subscription.findOne({
            userId,
            status: 'active',
            endDate: { $gt: new Date() }
        });

        let businessPlan = 'plan1';
        let businessSubscriptionStatus = 'pending';

        if (userSubscription) {
            if (userSubscription.plan === 'small_business') {
                businessPlan = 'plan2';
                businessSubscriptionStatus = 'active';
            } else if (userSubscription.plan === 'corporate') {
                businessPlan = 'plan3';
                businessSubscriptionStatus = 'active';
            }
        }

        const businessData = {
            userId,
            businessName: trimmedBusinessName,
            businessType,
            description,
            category: normalizedCategory,
            subcategory: normalizedSubcategory,
            contact,
            location: resolvedLocation,
            tags: uniqueTags,
            website,
            plan: businessPlan,
            subscriptionStatus: businessSubscriptionStatus,
            isProfileCompleted: true
        };

        if (user.businessProfileId) {
            businessData._id = user.businessProfileId;
        }

        // Normalised, as above.
        if (normalisedGst) businessData.gstNumber = normalisedGst;
        if (normalisedAadhaar) businessData.aadhaarNumber = normalisedAadhaar;

        business = await Business.create(businessData);

        user.isBusinessProfile = true;
        if (!user.businessProfileId) {
            user.businessProfileId = business._id;
        }
        await user.save();
    }

    return res.status(existingBusiness ? 200 : 201).json(
        new ApiResponse(existingBusiness ? 200 : 201, {
            business,
            businessId: business._id,
            planSelectionRequired: true
        }, "Business profile created successfully. You can now update your business details using the update endpoint.")
    );
});

// GET /api/v1/business/profile[?userId=]
//
// `?userId=` used to be read by nobody: the controller was scoped entirely to
// req.user._id, so the website — which appends it when it needs another
// account's business (src/api/business.ts) — was handed back the VIEWER's own
// Business document. The viewer's business id then drove the rating widget on a
// stranger's profile, showing the viewer's own stars and totals there and
// making the rate button 403 with "Cannot rate your own business".
//
// Callers that send no userId (the mobile app, the owner screens) are unchanged.
export const getBusinessProfile = asyncHandler(async (req, res) => {
    const callerId = req.user._id;
    const { userId: requestedUserId } = req.query;

    if (requestedUserId && !mongoose.isValidObjectId(requestedUserId)) {
        throw new ApiError(400, "Invalid userId");
    }

    const userId = requestedUserId || callerId;
    const isOwner = userId.toString() === callerId.toString();

    const business = await Business.findOne({ userId }).lean();
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const businessObj = isOwner ? { ...business } : stripPrivateBusinessFields(business);
    if (businessObj.rating !== undefined) {
        delete businessObj.rating;
    }

    const isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';

    return res.status(200).json(
        new ApiResponse(200, {
            business: businessObj,
            visibility: {
                isContentVisible,
                message: isContentVisible
                    ? 'Your business content is visible to all users'
                    : 'Your product, service and business listings are not promoted until you upgrade.'
            }
        }, "Business profile fetched successfully")
    );
});

// Strips everything a stranger must never see off a lean Business document.
//
// This endpoint is public (no token required) and used to return the whole
// document minus gstNumber, which meant the seller's bank account number,
// IFSC, UPI id, payment QR, Aadhaar number and the CDN links to their uploaded
// Aadhaar/PAN/licence scans were readable by anyone who knew the business id —
// and the id is handed out by GET /users/profile/other. Only the owner (and the
// admin panel, which has its own /admin/businesses/:businessId/details route)
// may see them.
//
// contact.phone and contact.email go too. They are the seller's personal mobile
// number and email, and the whole contact-request feature (model, four
// endpoints, an inbox screen) exists to gate them: getRequestStatus returns
// contactInfo only once the owner has APPROVED the asker. Shipping them in the
// public business payload handed them to anyone — including callers with no
// token — and made every denial the owner recorded meaningless. website and
// socialMedia stay: they are published marketing links, not PII.
const stripPrivateBusinessFields = (business) => {
    const publicBusiness = { ...business };

    delete publicBusiness.gstNumber;
    delete publicBusiness.aadhaarNumber;
    delete publicBusiness.bankDetails;
    delete publicBusiness.documents;
    // The account manager is a private arrangement with a Corporate customer: their
    // name, contact details and the admin ids behind them are for that business only.
    delete publicBusiness.accountManager;

    if (publicBusiness.contact) {
        const publicContact = { ...publicBusiness.contact };
        delete publicContact.phone;
        delete publicContact.email;
        publicBusiness.contact = publicContact;
    }

    return publicBusiness;
};

// GET /api/v1/business/:id
export const getBusinessById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const business = await Business.findById(id).lean();

    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const isOwner = !!req.user?._id &&
        business.userId?.toString() === req.user._id.toString();

    const visibleBusiness = isOwner ? business : stripPrivateBusinessFields(business);

    const owner = await User.findById(business.userId)
        .select("username avatar fullName")
        .lean();

    if (!owner) {
        throw new ApiError(404, "Business owner not found");
    }

    const ratingStats = await BusinessRating.aggregate([
        { $match: { businessId: new mongoose.Types.ObjectId(id) } },
        {
            $group: {
                _id: null,
                totalRatings: { $sum: 1 },
                averageRating: { $avg: '$rating' }
            }
        }
    ]);

    const ratingInfo = ratingStats.length > 0 ? {
        averageRating: Math.round(ratingStats[0].averageRating * 10) / 10,
        totalRatings: ratingStats[0].totalRatings
    } : {
        averageRating: 0,
        totalRatings: 0
    };

    const isContentVisible = business.subscriptionStatus === 'active' && business.plan !== 'plan1';

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                ...visibleBusiness,
                rating: ratingInfo.averageRating,
                totalRatings: ratingInfo.totalRatings
            },
            owner,
            visibility: {
                isContentVisible,
                message: isContentVisible
                    ? 'Business content is visible'
                    : 'Product, service and business listings are not promoted until this business upgrades.'
            }
        }, "Business profile fetched successfully")
    );
});

// PATCH /api/v1/business/update
export const updateBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    const {
        businessName,
        businessType,
        description,
        category,
        subcategory,
        contact,
        location,
        website,
        tags,
        gstNumber,
        aadhaarNumber
    } = req.body;

    if (businessName) {
        const trimmedBusinessName = businessName.trim();
        const existingBusinessByName = await Business.findOne({
            businessName: trimmedBusinessName,
            userId: { $ne: userId }
        });

        if (existingBusinessByName) {
            throw new ApiError(409, "Business name already in use");
        }

        business.businessName = trimmedBusinessName;
    }

    // Changing an identity number invalidates the approval that was granted
    // against the OLD one.
    //
    // admin/aadhaar.controllers.js sets isVerified / verificationStatus /
    // verifiedAt / verifiedBy after an admin has personally read the scan that
    // matches the number on file. Rewriting the number afterwards left every one
    // of those flags in place, so a seller could earn the badge with a genuine
    // Aadhaar and then point the record at an identity nobody checked — and the
    // pending-verification queue would never resurface them, because it filters
    // on isVerified:false. banking.js already does exactly this reset when the
    // bank account changes; the KYC fields were simply missed.
    let kycIdentityChanged = false;

    if (gstNumber !== undefined) {
        let gstChanged = false;

        if (gstNumber && gstNumber.trim() !== '') {
            // Same format rule as the create path: exactly 15 uppercase
            // alphanumerics. `length < 15` alone was a floor, not a format, so
            // a spaced or over-length value passed and was stored verbatim.
            const normalisedGst = gstNumber.replace(/\s+/g, '').toUpperCase();
            if (!/^[0-9A-Z]{15}$/.test(normalisedGst)) {
                throw new ApiError(400, "GST number must be exactly 15 letters or digits, with no spaces");
            }

            const existingGST = await Business.findOne({
                gstNumber: normalisedGst,
                userId: { $ne: userId }
            });
            if (existingGST) {
                throw new ApiError(409, "GST number already registered");
            }
            // Compare LIKE WITH LIKE. Rows written before this validation
            // existed hold whatever the client sent — the app stored GST
            // exactly as typed, so lower case is on file. Comparing a freshly
            // normalised value against one of those makes an UNCHANGED number
            // look changed exactly once per row, and a "change" here revokes
            // the admin's KYC approval and pushes the seller back into the
            // pending queue for editing something unrelated. Normalising both
            // sides means the first save after this deploy quietly repairs the
            // stored value instead of costing the seller their badge.
            if (normaliseGst(business.gstNumber) !== normalisedGst) gstChanged = true;
            business.gstNumber = normalisedGst;
        } else {
            if (business.gstNumber) gstChanged = true;
            business.gstNumber = undefined;
        }

        if (gstChanged) {
            kycIdentityChanged = true;
            business.gstVerified = false;
            business.gstVerifiedAt = null;
            business.gstVerifiedBy = null;
        }
    }

    if (aadhaarNumber !== undefined) {
        let aadhaarChanged = false;

        if (aadhaarNumber && aadhaarNumber.trim() !== '') {
            // Exactly 12 digits. There was NO validation here at all, and the
            // website posts the number back in its display form
            // ("XXXX XXXX XXXX"), so the stored value depended on which client
            // wrote it — and comparing the two forms made an unchanged number
            // look changed, needlessly revoking the admin's KYC approval.
            const normalisedAadhaar = normaliseAadhaar(aadhaarNumber);
            if (!/^\d{12}$/.test(normalisedAadhaar)) {
                throw new ApiError(400, "Aadhaar number must be exactly 12 digits, with no spaces");
            }
            // Both sides normalised — see the GST branch above. This one bites
            // hardest: the website renders Aadhaar grouped as "XXXX XXXX XXXX"
            // and posts back what it renders, so every website-written row on
            // file holds the spaced form. Comparing that against the stripped
            // value would revoke KYC approval on the seller's next save.
            if (normaliseAadhaar(business.aadhaarNumber) !== normalisedAadhaar) aadhaarChanged = true;
            business.aadhaarNumber = normalisedAadhaar;
        } else {
            if (business.aadhaarNumber) aadhaarChanged = true;
            business.aadhaarNumber = undefined;
        }

        if (aadhaarChanged) {
            kycIdentityChanged = true;
            business.aadhaarVerified = false;
            business.aadhaarVerifiedAt = null;
            business.aadhaarVerifiedBy = null;
        }
    }

    if (kycIdentityChanged) {
        business.verificationStatus = 'pending';
        business.verificationRemarks = undefined;
        business.verifiedAt = null;
        business.verifiedBy = null;

        // isVerified is overloaded: an admin KYC approval sets it, and so does a
        // paid subscription (subscription/payment.js). Only the KYC-derived
        // badge is being revoked here, so a paying subscriber keeps the badge
        // they bought while still going back through the admin queue.
        const hasPaidPlan = business.subscriptionStatus === 'active' && business.plan !== 'plan1';
        if (!hasPaidPlan) {
            business.isVerified = false;
        }
    }

    if (category) {
        if (!BUSINESS_CATEGORIES.includes(category)) {
            throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
        }
        business.category = category.trim();
    }

    if (subcategory) {
        business.subcategory = subcategory.trim();
    }

    if (businessType) business.businessType = businessType;
    if (description) business.description = description;

    if (location) {
        let resolvedLocation = { ...business.location, ...location };

        if (location.address || location.city || location.state || location.country) {
            const locationString = [
                resolvedLocation.address,
                resolvedLocation.city,
                resolvedLocation.state,
                resolvedLocation.country
            ].filter(Boolean).join(', ');

            if (locationString) {
                try {
                    const coords = await getCoordinates(locationString);
                    if (coords?.latitude && coords?.longitude) {
                        resolvedLocation.coordinates = {
                            type: "Point",
                            coordinates: [coords.longitude, coords.latitude]
                        };
                        resolvedLocation.isLiveLocationEnabled = true;
                        resolvedLocation.lastLocationUpdate = new Date();
                    }
                } catch (error) {
                    // Continue without updating coordinates if resolution fails
                }
            }
        }

        business.location = resolvedLocation;
    }

    if (contact) {
        if (contact.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(contact.email)) {
                throw new ApiError(400, "Invalid contact.email format");
            }
        }

        if (contact.website && !/^https?:\/\/.+/.test(contact.website)) {
            throw new ApiError(400, "Invalid contact.website URL");
        }

        business.contact = { ...business.contact, ...contact };
    }

    if (website) {
        if (!/^https?:\/\/.+/.test(website)) {
            throw new ApiError(400, "Invalid website URL");
        }
        business.website = website;
    }

    if (tags && Array.isArray(tags)) {
        if (tags.length > 0) {
            const manualTags = tags
                .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
                .map(tag => tag.toLowerCase().trim());

            if (manualTags.length === 0) {
                throw new ApiError(400, "Tags must be non-empty strings");
            }

            business.tags = [...new Set(manualTags)];
        } else {
            const autoTags = extractTagsFromText(
                business.businessName,
                business.description,
                business.category,
                business.subcategory
            );
            business.tags = [...new Set(autoTags.map(tag => tag.toLowerCase()))];
        }
    }

    await business.save();

    const businessObj = business.toObject();
    delete businessObj.rating;

    return res.status(200).json(
        new ApiResponse(200, { business: businessObj }, "Business profile updated successfully")
    );
});

// DELETE /api/v1/business/delete
export const deleteBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, "User not found");

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    // Money still in escrow blocks the delete.
    //
    // Payout is manual: an admin opens the order, reads THIS document's
    // bankDetails and transfers the money by hand. adminEscrow.controllers.js
    // resolves the destination at release time from
    // order.sellerId.businessProfileId -> Business.bankDetails, so deleting the
    // row (and clearing user.businessProfileId below) leaves the admin with
    // sellerBankDetails:null — and manualReleasePayment still flips the order to
    // 'released' and debits the escrow ledger, after which the order matches
    // neither RELEASABLE_PAYMENT_STATUSES nor the refund path. The seller's money
    // is marked paid out with no record of where to send it.
    const { default: Order } = await import("../../models/order.models.js");
    const heldOrders = await Order.countDocuments({
        sellerId: userId,
        paymentStatus: { $in: ['held', 'paid'] }
    });
    if (heldOrders > 0) {
        throw new ApiError(
            409,
            `You have ${heldOrders} order(s) with payment still in escrow. Your business profile cannot be deleted until those payouts are settled.`
        );
    }

    // Business posts are removed WITH everything that points at them.
    //
    // This was a bare deleteMany — a second, parallel delete path that skipped
    // every cleanup the real one performs. The posts vanished while their
    // media stayed on Bunny forever, and their likes, comments, saved-post
    // entries, interactions and reports were left referencing ids that no
    // longer resolve, which then render as blank cards and skew the counts
    // built from them.
    const { default: Post } = await import("../../models/userPost.models.js");
    const { default: Like } = await import("../../models/like.models.js");
    const { default: Comment } = await import("../../models/comment.models.js");
    const { default: SavedPost } = await import("../../models/savedPost.models.js");
    const { default: PostInteraction } = await import("../../models/postInteraction.models.js");
    const { default: Report } = await import("../../models/report.models.js");
    const { deleteMultipleFromBunny } = await import("../../utils/bunny.js");

    const businessPosts = await Post.find({ userId, contentType: 'business' })
        .select('_id media').lean();
    const postIds = businessPosts.map(p => p._id);

    const mediaUrls = [];
    for (const p of businessPosts) {
        for (const m of p.media || []) {
            if (m.url) mediaUrls.push(m.url);
            if (m.thumbnailUrl) mediaUrls.push(m.thumbnailUrl);
            for (const extra of m.additionalMedia || []) {
                if (extra.url) mediaUrls.push(extra.url);
                if (extra.thumbnailUrl) mediaUrls.push(extra.thumbnailUrl);
            }
        }
    }

    // The Business row carries two more Bunny assets of its own: the uploaded
    // verification scans (documents[].documentUrl — Aadhaar, PAN, licence) and
    // the payment QR image. Only post media was being collected, so those
    // survived the delete on a public pull zone with no token auth, while
    // Business.deleteOne destroyed the only record of their URLs — nobody could
    // even enumerate what was left behind. Government ID scans are the last
    // thing that should outlive an account deletion request.
    for (const doc of business.documents || []) {
        if (doc.documentUrl) mediaUrls.push(doc.documentUrl);
    }
    if (business.bankDetails?.paymentQRCode) {
        mediaUrls.push(business.bankDetails.paymentQRCode);
    }

    // Rows first, then media — a failed Bunny call leaves orphaned files, which
    // is recoverable; the reverse leaves live posts with dead images, which is not.
    const deletedPosts = await Post.deleteMany({ userId, contentType: 'business' });

    if (postIds.length) {
        await Promise.allSettled([
            Like.deleteMany({ postId: { $in: postIds } }),
            cancelBoostsForPost(postIds),
            Comment.deleteMany({ postId: { $in: postIds } }),
            SavedPost.deleteMany({ postId: { $in: postIds } }),
            PostInteraction.deleteMany({ postId: { $in: postIds } }),
            Report.deleteMany({ reportedPostId: { $in: postIds } }),
            Post.db.model('User').updateMany(
                { posts: { $in: postIds } },
                { $pull: { posts: { $in: postIds } } }
            ),
        ]);
    }

    if (mediaUrls.length) {
        await deleteMultipleFromBunny(mediaUrls).catch((e) =>
            console.warn(`[business] media cleanup failed: ${e?.message}`));
    }

    await Business.deleteOne({ userId });

    user.isBusinessProfile = false;
    user.businessProfileId = undefined;
    await user.save();

    return res.status(200).json(
        new ApiResponse(200, {
            deletedPostsCount: deletedPosts.deletedCount
        }, `Business profile and ${deletedPosts.deletedCount} business posts deleted successfully`)
    );
});

// GET /api/v1/business/my-category
export const getMyBusinessCategory = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const business = await Business.findOne({ userId }).select('category subcategory businessName').lean();
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            category: business.category,
            subcategory: business.subcategory,
            businessName: business.businessName
        }, "Business category and subcategory fetched successfully")
    );
});

// PATCH /api/v1/business/update-category
export const updateBusinessCategory = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { category, subcategory } = req.body;

    if (!category) {
        throw new ApiError(400, "Category is required");
    }

    if (!BUSINESS_CATEGORIES.includes(category)) {
        throw new ApiError(400, `Invalid category. Must be one of: ${BUSINESS_CATEGORIES.join(', ')}`);
    }

    let business = await Business.findOne({ userId });

    if (!business) {
        // subscriptionStatus starts 'pending', NOT 'active'.
        //
        // The pre-save hook in business.models.js turns any transition into
        // 'active' — including the one on a freshly created document — into
        // isVerified:true, so picking a category was minting the public
        // verification badge before a name, address, GST, Aadhaar or a single
        // document existed, and admin/aadhaar.controllers.js would never queue
        // the row for review because that filter requires isVerified:false.
        // Nothing is lost by starting at 'pending': every entitlement gate reads
        // `subscriptionStatus === 'active' && plan !== 'plan1'`, and the plan
        // here is plan1, so content visibility is unchanged either way.
        business = await Business.create({
            userId,
            category: category.trim(),
            subcategory: subcategory ? subcategory.trim() : undefined,
            plan: 'plan1',
            subscriptionStatus: 'pending'
        });

        const user = await User.findById(userId);
        if (user) {
            user.isBusinessProfile = true;
            user.businessProfileId = business._id;
            await user.save();
        }

        const businessObj = business.toObject();
        delete businessObj.rating;

        return res.status(201).json(
            new ApiResponse(201, {
                business: businessObj,
                updatedCategory: business.category,
                updatedSubcategory: business.subcategory,
                message: "Business profile created with category"
            }, "Business category set successfully")
        );
    }

    business.category = category.trim();
    if (subcategory) {
        business.subcategory = subcategory.trim();
    }
    await business.save();

    const businessObj = business.toObject();
    delete businessObj.rating;

    return res.status(200).json(
        new ApiResponse(200, {
            business: businessObj,
            updatedCategory: business.category,
            updatedSubcategory: business.subcategory
        }, "Business category updated successfully")
    );
});

// GET /api/v1/business/categories
export const getBusinessCategories = asyncHandler(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, {
            categories: BUSINESS_CATEGORIES,
            totalCategories: BUSINESS_CATEGORIES.length
        }, "Business categories fetched successfully")
    );
});
