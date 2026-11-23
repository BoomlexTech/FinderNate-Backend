import Business from "../../models/business.models.js";
import { createBusinessVerificationNotification } from "../notification.controllers.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { exactIdSearchClauses, maskBusinessIdsForAdmin } from "../../utils/businessPrivacy.utils.js";

// GET /api/v1/admin/aadhaar-verification/pending
export const getPendingAadhaarVerifications = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search } = req.query;

    const pending = {
        $or: [
            { 'documents': { $elemMatch: { documentType: 'aadhaar', verified: false } } },
            { aadhaarNumber: { $exists: true, $ne: null, $ne: "" }, isVerified: false }
        ]
    };

    // Business name, or a whole Aadhaar number / GSTIN (they are masked in this
    // panel, so no partial match on them). This used to put the filter inside
    // itself (`filter.$and = [filter, …]`), and every search failed with
    // "Maximum call stack size exceeded".
    const filter = search
        ? {
            $and: [
                pending,
                { $or: [{ businessName: { $regex: search, $options: 'i' } }, ...exactIdSearchClauses(search)] }
            ]
        }
        : pending;

    const businesses = await Business.find(filter)
        .populate('userId', 'username fullName email phoneNumber')
        .populate('documents.verifiedBy', 'username fullName')
        .select('businessName aadhaarNumber gstNumber contact location documents createdAt')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const businessesWithAadhaarDocs = businesses.map(business => {
        const businessObj = business.toObject();
        if (businessObj.documents) {
            businessObj.documents = businessObj.documents.filter(
                doc => doc.documentType === 'aadhaar' && !doc.verified
            );
        }
        return businessObj;
    });

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            // The GSTIN's PAN part masked, as everywhere in the admin panel.
            businesses: businessesWithAadhaarDocs.map(maskBusinessIdsForAdmin),
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Pending Aadhaar verifications fetched successfully")
    );
});

// POST /api/v1/admin/aadhaar-verification/verify/:businessId
export const verifyAadhaarCard = asyncHandler(async (req, res) => {
    const { businessId } = req.params;
    const { status, remarks } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        throw new ApiError(400, "Status must be either 'approved' or 'rejected'");
    }

    const business = await Business.findById(businessId).populate('userId');
    if (!business) {
        throw new ApiError(404, "Business not found");
    }

    if (!business.aadhaarNumber) {
        throw new ApiError(400, "No Aadhaar number found for this business");
    }

    if (status === 'approved') {
        business.isVerified = true;
        business.verificationStatus = 'approved';
        business.verificationRemarks = remarks || 'Aadhaar verification approved';
        business.verifiedAt = new Date();
        business.verifiedBy = req.admin._id;
    } else {
        business.isVerified = false;
        business.verificationStatus = 'rejected';
        business.verificationRemarks = remarks || 'Aadhaar verification rejected';
        business.rejectedAt = new Date();
        business.rejectedBy = req.admin._id;
    }

    await business.save();

    await req.admin.logActivity(
        `aadhaar_verification_${status}`,
        'business',
        businessId,
        `Aadhaar verification ${status} for business: ${business.businessName}`
    );

    // Tell the owner. Approving used to be silent — the record changed and
    // nothing reached the person whose business it was, so the only way to find
    // out was to keep opening the profile and checking.
    //
    // Fire-and-forget with a terminal catch: a failed notification must not
    // undo a decision the admin has already made and been shown as saved.
    createBusinessVerificationNotification({
        recipientId: business.userId?._id || business.userId,
        approved: status === 'approved',
        businessName: business.businessName,
        remarks: business.verificationRemarks,
    }).catch((e) => console.warn(`[notify] verification notice failed: ${e?.message}`));

    return res.status(200).json(
        new ApiResponse(200, {
            business: {
                _id: business._id,
                businessName: business.businessName,
                isVerified: business.isVerified,
                verificationStatus: business.verificationStatus,
                verificationRemarks: business.verificationRemarks
            }
        }, `Aadhaar verification ${status} successfully`)
    );
});

// GET /api/v1/admin/aadhaar-verification/history
export const getAadhaarVerificationHistory = asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;

    let filter = {
        aadhaarNumber: { $exists: true, $ne: null, $ne: "" },
        verificationStatus: { $exists: true }
    };

    if (status && ['approved', 'rejected'].includes(status)) {
        filter.verificationStatus = status;
    }

    const businesses = await Business.aggregate([
        { $match: filter },
        {
            $addFields: {
                lastVerificationDate: {
                    $max: ['$verifiedAt', '$rejectedAt']
                }
            }
        },
        { $sort: { lastVerificationDate: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit * 1 },
        {
            $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                as: 'userId',
                pipeline: [{ $project: { username: 1, fullName: 1, email: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'verifiedBy',
                foreignField: '_id',
                as: 'verifiedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $lookup: {
                from: 'admins',
                localField: 'rejectedBy',
                foreignField: '_id',
                as: 'rejectedBy',
                pipeline: [{ $project: { fullName: 1, username: 1 } }]
            }
        },
        {
            $project: {
                businessName: 1,
                aadhaarNumber: 1,
                verificationStatus: 1,
                verificationRemarks: 1,
                verifiedAt: 1,
                rejectedAt: 1,
                userId: { $arrayElemAt: ['$userId', 0] },
                verifiedBy: { $arrayElemAt: ['$verifiedBy', 0] },
                rejectedBy: { $arrayElemAt: ['$rejectedBy', 0] }
            }
        }
    ]);

    const totalBusinesses = await Business.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            // Aadhaar as its last four digits only (23 Nov 2026).
            businesses: businesses.map(maskBusinessIdsForAdmin),
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalBusinesses / limit),
                totalBusinesses,
                hasNext: page < Math.ceil(totalBusinesses / limit),
                hasPrev: page > 1
            }
        }, "Aadhaar verification history fetched successfully")
    );
});
