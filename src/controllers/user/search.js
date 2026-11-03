import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import Business from "../../models/business.models.js";
import SearchSuggestion from "../../models/searchSuggestion.models.js";
import { addBadgesToUsers } from "../../utils/userBadge.utils.js";
import {
    generateRealtimeUsernameSuggestions,
    isUsernameAvailable,
    validateUsername,
} from "../../utils/usernameSuggestions.js";

const searchUsers = asyncHandler(async (req, res) => {
    const { query } = req.query;
    const userId = req.user?._id;
    const blockedUsers = req.blockedUsers || [];
    let matchingBusinesses = [];

    if (!query || query.trim() == "") {
        throw new ApiError(400, "Search query is required");
    }

    if (query.trim().length >= 3) {
        const normalizedKeyword = query.trim().toLowerCase();
        try {
            const existingSuggestion = await SearchSuggestion.findOne({ keyword: normalizedKeyword });

            if (existingSuggestion) {
                existingSuggestion.searchCount += 1;
                existingSuggestion.lastSearched = new Date();
                await existingSuggestion.save();
            } else {
                await SearchSuggestion.create({
                    keyword: normalizedKeyword,
                    searchCount: 1,
                    lastSearched: new Date()
                });
            }
        } catch (error) {
        }
    }

    const searchQuery = {
        accountStatus: "active",
        isDeleted: { $ne: true },
        $or: [
            { username: new RegExp(query, "i") },
            { fullName: new RegExp(query, "i") },
            { fullNameLower: new RegExp(query, "i") }
        ]
    };

    if (blockedUsers.length > 0) {
        searchQuery._id = { $nin: blockedUsers };
    }

    let user = await User.find(searchQuery)
        .select("username fullName profileImageUrl bio location isAddressHidden isBusinessProfile businessProfileId")
        .populate({
            path: 'businessProfileId',
            select: 'category subcategory businessName businessType'
        });

    if (user.length === 0) {
        const fallbackQuery = {
            accountStatus: "active",
            isDeleted: { $ne: true },
            $or: [
                { username: new RegExp(query, "i") },
                { fullName: new RegExp(query, "i") }
            ]
        };

        if (blockedUsers.length > 0) {
            fallbackQuery._id = { $nin: blockedUsers };
        }

        user = await User.find(fallbackQuery)
            .select("username fullName profileImageUrl bio location isAddressHidden isBusinessProfile businessProfileId")
            .populate({
                path: 'businessProfileId',
                select: 'category subcategory businessName businessType'
            });
    }

    const businessSearchQuery = {
        $or: [
            { category: new RegExp(query, "i") },
            { subcategory: new RegExp(query, "i") },
            { businessName: new RegExp(query, "i") },
            { businessType: new RegExp(query, "i") },
            { tags: new RegExp(query, "i") }
        ],
        userId: { $nin: blockedUsers }
    };

    matchingBusinesses = await Business.find(businessSearchQuery)
        .populate({
            path: 'userId',
            match: { accountStatus: "active" },
            select: "username fullName profileImageUrl bio location isAddressHidden isBusinessProfile businessProfileId"
        })
        .select('category subcategory businessName businessType tags');

    const validBusinessUsers = matchingBusinesses
        .filter(business => business.userId)
        .map(business => {
            const userObj = business.userId.toObject();
            return {
                ...userObj,
                businessProfileId: {
                    category: business.category,
                    subcategory: business.subcategory,
                    businessName: business.businessName,
                    businessType: business.businessType
                }
            };
        });

    if (validBusinessUsers.length > 0) {
        user = [...user, ...validBusinessUsers];
    }

    user = await addBadgesToUsers(user);

    const formattedUsersMap = new Map();

    const addFormattedUser = (rawUserObj, businessInfo) => {
        if (!rawUserObj || !rawUserObj._id) return;
        const id = rawUserObj._id.toString();
        if (formattedUsersMap.has(id)) return;

        const formatted = {
            _id: rawUserObj._id,
            username: rawUserObj.username,
            fullName: rawUserObj.fullName,
            bio: rawUserObj.bio,
            // Hidden by the owner's "Hide address" switch (#12).
            location: rawUserObj.isAddressHidden ? null : rawUserObj.location,
            profileImageUrl: rawUserObj.profileImageUrl,
            subscriptionBadge: rawUserObj.subscriptionBadge || null
        };

        if (businessInfo) {
            formatted.businessCategory = businessInfo.category;
            formatted.businessSubcategory = businessInfo.subcategory;
            formatted.businessName = businessInfo.businessName;
            formatted.businessType = businessInfo.businessType;
        } else if (rawUserObj.isBusinessProfile && rawUserObj.businessProfileId) {
            formatted.businessCategory = rawUserObj.businessProfileId.category;
            formatted.businessSubcategory = rawUserObj.businessProfileId.subcategory;
            formatted.businessName = rawUserObj.businessProfileId.businessName;
            formatted.businessType = rawUserObj.businessProfileId.businessType;
        }

        formattedUsersMap.set(id, formatted);
    };

    for (const userDoc of user) {
        const obj = typeof userDoc?.toObject === 'function' ? userDoc.toObject() : userDoc;

        if (obj.businessProfileId && obj.businessProfileId.category) {
            addFormattedUser(obj, obj.businessProfileId);
        } else {
            addFormattedUser(obj, null);
        }
    }

    const formattedUsers = Array.from(formattedUsersMap.values());

    return res
        .status(200)
        .json(new ApiResponse(200, formattedUsers, "Users found successfully"));
});

const trackSearch = asyncHandler(async (req, res) => {
    const { keyword } = req.body;

    if (!keyword || !keyword.trim()) {
        throw new ApiError(400, "Keyword is required");
    }

    const normalizedKeyword = keyword.trim().toLowerCase();

    try {
        const existingSuggestion = await SearchSuggestion.findOne({ keyword: normalizedKeyword });

        if (existingSuggestion) {
            existingSuggestion.searchCount += 1;
            existingSuggestion.lastSearched = new Date();
            await existingSuggestion.save();
        } else {
            await SearchSuggestion.create({
                keyword: normalizedKeyword,
                searchCount: 1,
                lastSearched: new Date()
            });
        }

        return res.status(200).json(
            new ApiResponse(200, null, "Search tracked successfully")
        );
    } catch (error) {
        console.error("Error tracking search:", error);
        throw new ApiError(500, "Failed to track search");
    }
});

const getPopularSearches = asyncHandler(async (req, res) => {
    const MAX_LIMIT = 50;
    const requestedLimit = parseInt(req.query.limit) || 10;
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    try {
        const popularSearches = await SearchSuggestion.find({})
            .sort({ searchCount: -1, lastSearched: -1 })
            .limit(limit)
            .select('keyword searchCount');

        const formattedResults = popularSearches.map(search => ({
            keyword: search.keyword,
            searchCount: search.searchCount
        }));

        return res.status(200).json(
            new ApiResponse(200, formattedResults, "Popular searches retrieved successfully")
        );
    } catch (error) {
        console.error("Error fetching popular searches:", error);
        throw new ApiError(500, "Failed to fetch popular searches");
    }
});

const getUsernameSuggestions = asyncHandler(async (req, res) => {
    const { username } = req.query;

    if (!username) {
        throw new ApiError(400, "Username query parameter is required");
    }

    if (username.length < 3) {
        return res.status(200).json(
            new ApiResponse(200, {
                suggestions: [],
                isAvailable: false,
                message: "Username must be at least 3 characters"
            }, "Username too short")
        );
    }

    try {
        const result = await generateRealtimeUsernameSuggestions(username, 8);
        return res.status(200).json(
            new ApiResponse(200, result, "Username suggestions generated successfully")
        );
    } catch (error) {
        console.error('Error generating username suggestions:', error);
        throw new ApiError(500, "Failed to generate username suggestions");
    }
});

const checkUsernameAvailability = asyncHandler(async (req, res) => {
    const { username } = req.query;

    if (!username) {
        throw new ApiError(400, "Username query parameter is required");
    }

    const validation = validateUsername(username);
    if (!validation.isValid) {
        return res.status(200).json(
            new ApiResponse(200, {
                isAvailable: false,
                isValid: false,
                errors: validation.errors
            }, "Username validation failed")
        );
    }

    try {
        const isAvailable = await isUsernameAvailable(username);
        return res.status(200).json(
            new ApiResponse(200, {
                isAvailable,
                isValid: true,
                username: username.toLowerCase()
            }, isAvailable ? "Username is available" : "Username is already taken")
        );
    } catch (error) {
        console.error('Error checking username availability:', error);
        throw new ApiError(500, "Failed to check username availability");
    }
});

export {
    searchUsers,
    trackSearch,
    getPopularSearches,
    getUsernameSuggestions,
    checkUsernameAvailability,
};
