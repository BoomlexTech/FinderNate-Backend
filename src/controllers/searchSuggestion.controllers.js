import SearchSuggestion from '../models/searchSuggestion.models.js';
import { User } from '../models/user.models.js';
import Post from '../models/userPost.models.js';
import Reel from '../models/reels.models.js';
import Business from '../models/business.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getBlockedUsersFilter } from '../middlewares/blocking.middleware.js';
import { publicUserPopulate, scrubHiddenLocations } from "../utils/profilePrivacy.utils.js";

/**
 * Enhanced search suggestions that always include user profiles with their posts, reels, and business information
 * Provides comprehensive search results including:
 * - Keyword suggestions from search history
 * - User profiles matching the search query
 * - Business profiles and categories
 * - User posts and reels
 * - Business information for users
 */
export const getSearchSuggestions = asyncHandler(async (req, res) => {
    const { q, limit = 10, includeUserPosts } = req.query; // includeUserPosts is kept for backward compatibility but always returns user profiles



    if (!q || q.trim().length < 2) {
        throw new ApiError(400, "Search query must be at least 2 characters long");
    }

    const keyword = q.trim().toLowerCase();
    //* The raw query used to go straight into new RegExp() (and into $regex
    //* below), so a query like "a(" threw and 500'd the endpoint the search box
    //* calls on every keystroke.
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(safeKeyword, 'i');

    //* Blocking was not applied here AT ALL — this endpoint has no
    //* getBlockedUsers middleware on its route and the handler never asked for
    //* the list, so a blocked account's profile, posts and reels came straight
    //* back through the search-suggestions dropdown while every other search
    //* surface correctly hid them. Reuses the same cached helper the middleware
    //* uses rather than defining "blocked" a second time; the route is
    //* verifyJWT-only, so req.user is always present.
    const blockedFilter = await getBlockedUsersFilter(req.user?._id);
    const blockedUsers = blockedFilter?._id?.$nin || [];
    //* Private posts must never leak through suggestions either — the main
    //* search path has always guarded this and this one did not.
    const publicPostFilter = { 'settings.privacy': { $ne: 'private' } };

    // Get keyword suggestions from search history
    const suggestions = await SearchSuggestion.find({
        keyword: { $regex: `^${safeKeyword}`, $options: 'i' }
    })
        .sort({ searchCount: -1, lastSearched: -1 })
        .limit(parseInt(limit))
        .select('keyword');

    const keywords = suggestions.map(s => s.keyword);

    // Always include user profiles in search suggestions for better user experience
    const shouldIncludePosts = includeUserPosts === 'true' || includeUserPosts === true || includeUserPosts === '1';
    const finalShouldIncludePosts = true; // Always include user profiles

    if (finalShouldIncludePosts) {
        // Enhanced user search - Find users matching the search query across multiple fields
        const users = await User.find({
            $or: [
                { username: searchRegex },
                { fullName: searchRegex },
                { bio: searchRegex },
                { 'customization.normal.location.name': searchRegex },
                { 'customization.product.location.name': searchRegex },
                { 'customization.service.location.city': searchRegex },
                { 'customization.service.location.state': searchRegex },
                { 'customization.service.location.country': searchRegex },
                { 'customization.business.location.city': searchRegex },
                { 'customization.business.location.state': searchRegex },
                { 'customization.business.location.country': searchRegex },
                { 'customization.business.location.name': searchRegex },
                { 'customization.business.location.address': searchRegex },
                { 'customization.business.location.pincode': searchRegex },
                { 'customization.business.category': searchRegex },
                { 'customization.business.subcategory': searchRegex }
            ],
            _id: { $nin: blockedUsers }
        })
            .limit(parseInt(limit))
            .select('username fullName profileImageUrl bio location isAddressHidden customization')
            .transform(scrubHiddenLocations);

        // Also find users through business category and subcategory search
        const businessUsersByCategory = await Business.find({
            $or: [
                { category: searchRegex },
                { subcategory: searchRegex },
                { businessName: searchRegex },
                { businessType: searchRegex },
                { tags: searchRegex }
            ],
            userId: { $nin: blockedUsers }
        })
            .populate(publicUserPopulate('userId', 'username fullName profileImageUrl bio location customization'))
            .limit(parseInt(limit))
            .lean();

        // Combine user results, avoiding duplicates
        const allUserIds = new Set();
        const allUsers = [];

        // Add direct user search results
        users.forEach(user => {
            if (!allUserIds.has(user._id.toString())) {
                allUserIds.add(user._id.toString());
                allUsers.push(user);
            }
        });

        // Add business category search results
        businessUsersByCategory.forEach(business => {
            if (business.userId && !allUserIds.has(business.userId._id.toString())) {
                allUserIds.add(business.userId._id.toString());
                allUsers.push(business.userId);
            }
        });

        // Limit the combined results
        const limitedUsers = allUsers.slice(0, parseInt(limit));



        // Fetch posts for each user found - exactly like searchAllContent
        const usersWithPosts = await Promise.all(limitedUsers.map(async (user) => {
            const userPosts = await Post.find({ userId: user._id, ...publicPostFilter })
                .sort({ createdAt: -1 })
                .limit(10) // Limit to 10 recent posts per user (same as searchAllContent)
                .lean();

            const userReels = await Reel.find({ userId: user._id })
                .sort({ createdAt: -1 })
                .limit(5) // Limit to 5 recent reels per user (same as searchAllContent)
                .lean();

            // Check if user has a business profile
            const businessProfile = await Business.findOne({ userId: user._id })
                .select('businessName category subcategory businessType tags isVerified rating')
                .lean();

            return {
                ...user.toObject(),
                business: businessProfile,
                posts: userPosts,
                reels: userReels,
                totalPosts: await Post.countDocuments({ userId: user._id, ...publicPostFilter }),
                totalReels: await Reel.countDocuments({ userId: user._id })
            };
        }));

        // Now get all posts/reels from matching users for the main results array with population and scoring
        const allUserPosts = await Post.find({
            userId: { $in: limitedUsers.map(u => u._id) },
            ...publicPostFilter
        })
            .populate(publicUserPopulate('userId', 'username profileImageUrl bio location'))
            .sort({ createdAt: -1 })
            .lean();

        const allUserReels = await Reel.find({
            userId: { $in: limitedUsers.map(u => u._id) }
        })
            .populate(publicUserPopulate('userId', 'username profileImageUrl bio location'))
            .sort({ createdAt: -1 })
            .lean();

        // Add scoring system like searchAllContent
        const scoredPosts = allUserPosts.map(post => {
            const engagement = post.engagement || {};
            const score =
                (engagement.likes || 0) * 1 +
                (engagement.comments || 0) * 0.7 +
                (engagement.views || 0) * 0.5 +
                (engagement.shares || 0) * 0.5;

            let base = 0;
            switch (post.contentType) {
                case 'product': base = 1.5; break;
                case 'service': base = 1.2; break;
                case 'business': base = 1.0; break;
                case 'normal': base = 0.8; break;
            }

            return {
                ...post,
                _score: base + score + (new Date(post.createdAt).getTime() / 10000000000000),
                _type: 'post'
            };
        });

        const scoredReels = allUserReels.map(reel => {
            const engagement = reel.engagement || {};
            const score =
                (engagement.likes || 0) * 1 +
                (engagement.comments || 0) * 0.7 +
                (engagement.views || 0) * 1.5 +
                (engagement.shares || 0) * 0.5;

            return {
                ...reel,
                _score: 2 + score + (new Date(reel.createdAt).getTime() / 10000000000000),
                _type: 'reel'
            };
        });

        // Create combined results array like searchAllContent
        const combinedResults = [...scoredPosts, ...scoredReels]
            .sort((a, b) => b._score - a._score);


        return res.status(200).json(
            new ApiResponse(200, {
                results: combinedResults,
                users: usersWithPosts,
                pagination: {
                    page: 1,
                    limit: parseInt(limit),
                    total: combinedResults.length,
                    totalPages: Math.ceil(combinedResults.length / parseInt(limit))
                }
            }, "Search results retrieved successfully")
        );
    }

    // Default behavior - return just keywords
    return res.status(200).json(
        new ApiResponse(200, keywords, "Search suggestions retrieved successfully")
    );
});

