import Business from "../../models/business.models.js";
import BusinessRating from "../../models/businessRating.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import mongoose from "mongoose";
import { BUSINESS_CATEGORIES, calculateDistance } from "./helpers.js";

// PATCH /api/v1/business/live-location
export const updateLiveLocation = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { latitude, longitude, address } = req.body;

    if (!latitude || !longitude) {
        throw new ApiError(400, "Latitude and longitude are required for live location");
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        throw new ApiError(400, "Invalid coordinates provided");
    }

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    business.location = {
        ...business.location,
        coordinates: {
            type: "Point",
            coordinates: [longitude, latitude]
        },
        isLiveLocationEnabled: true,
        lastLocationUpdate: new Date()
    };

    if (address) {
        business.location.address = address;
    }

    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            location: business.location,
            message: "Live location updated successfully"
        }, "Live location updated successfully")
    );
});

// POST /api/v1/business/toggle-live-location
export const toggleLiveLocation = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
        throw new ApiError(400, "enabled field must be a boolean value");
    }

    const business = await Business.findOne({ userId });
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    if (!business.location) {
        business.location = {};
    }

    business.location.isLiveLocationEnabled = enabled;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            isLiveLocationEnabled: business.location.isLiveLocationEnabled
        }, `Live location ${enabled ? 'enabled' : 'disabled'} successfully`)
    );
});

// Strips everything a stranger must never see off a lean Business document.
// Mirrors stripPrivateBusinessFields in ./profile.js — this endpoint has the
// identical leak (bank account, IFSC, UPI id, payment QR, Aadhaar number and
// the CDN links to uploaded Aadhaar/PAN/licence scans) because it is public
// and previously only excluded gstNumber/aadhaarNumber via .select().
// contact.phone / contact.email are stripped here too: this route has no auth
// middleware at all, so leaving them in published every seller's personal mobile
// number and email to anonymous callers, bypassing the contact-request approval
// gate. website and socialMedia are published marketing links and stay.
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

// GET /api/v1/business/nearby?latitude=X&longitude=Y&radius=Z
export const getNearbyBusinesses = asyncHandler(async (req, res) => {
    const { latitude, longitude, radius = 5000, category, limit = 20 } = req.query;

    if (!latitude || !longitude) {
        throw new ApiError(400, "Latitude and longitude are required");
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const radiusInMeters = parseFloat(radius);

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new ApiError(400, "Invalid coordinates provided");
    }

    let query = {
        'location.coordinates': {
            $near: {
                $geometry: { type: 'Point', coordinates: [lng, lat] },
                $maxDistance: radiusInMeters
            }
        },
        'location.isLiveLocationEnabled': true,
        subscriptionStatus: 'active'
    };

    if (category && BUSINESS_CATEGORIES.includes(category)) {
        query.category = category;
    }

    const nearbyBusinesses = await Business.find(query)
        .populate('userId', 'username fullName profileImageUrl')
        .limit(parseInt(limit))
        .lean();

    const businessesWithDistance = await Promise.all(nearbyBusinesses.map(async (business) => {
        let businessWithDistance = stripPrivateBusinessFields(business);

        if (business.location?.coordinates?.coordinates) {
            const [businessLng, businessLat] = business.location.coordinates.coordinates;
            const distance = calculateDistance(lat, lng, businessLat, businessLng);
            businessWithDistance.distance = Math.round(distance * 100) / 100;
        }

        const ratingStats = await BusinessRating.aggregate([
            { $match: { businessId: new mongoose.Types.ObjectId(business._id) } },
            {
                $group: {
                    _id: null,
                    totalRatings: { $sum: 1 },
                    averageRating: { $avg: '$rating' }
                }
            }
        ]);

        businessWithDistance.rating = ratingStats.length > 0
            ? Math.round(ratingStats[0].averageRating * 10) / 10
            : 0;
        businessWithDistance.totalRatings = ratingStats.length > 0
            ? ratingStats[0].totalRatings
            : 0;

        return businessWithDistance;
    }));

    return res.status(200).json(
        new ApiResponse(200, {
            businesses: businessesWithDistance,
            count: businessesWithDistance.length,
            searchCenter: { latitude: lat, longitude: lng },
            radiusInMeters
        }, "Nearby businesses fetched successfully")
    );
});
