import Business from '../models/business.models.js';
import mongoose from 'mongoose';

/**
 * BUSINESS POST PRIORITY SYSTEM
 * ==============================
 *
 * Rules:
 * 1. Business accounts with an active payment plan receive highest priority
 * 2. Their posts, ads, and stories appear between normal posts and reels
 * 3. Paid business posts appear in search results for related tags and categories
 * 4. If two accounts post related content (same tags/categories)—one paid and one unpaid—
 *    only the paid account's post is visible
 * 5. Business posts without an active plan are hidden from ALL users, including followers
 *
 * Active Plan Definition:
 * - subscriptionStatus === 'active'
 * - plan !== 'plan1' (plan1 is the free plan)
 */

/**
 * Check if a business has an active payment plan
 * A business has an active plan if:
 * - subscriptionStatus === 'active'
 * - plan !== 'plan1' (plan1 is the free plan)
 *
 * @param {String|ObjectId} userId - The user ID associated with the business
 * @returns {Promise<Boolean>} - True if business has active payment plan
 */
export const hasActivePaymentPlan = async (userId) => {
    try {
        if (!userId) return false;
        
        const business = await Business.findOne({ userId }).select('plan subscriptionStatus').lean();
        
        if (!business) return false;
        
        // Check if subscription is active and plan is not the free plan
        return business.subscriptionStatus === 'active' && business.plan !== 'plan1';
    } catch (error) {
        console.error('Error checking business payment plan:', error);
        return false;
    }
};

/**
 * Get all business user IDs that have active payment plans
 * Useful for bulk filtering
 * 
 * @returns {Promise<Array<ObjectId>>} - Array of user IDs with active payment plans
 */
export const getActivePaymentPlanUserIds = async () => {
    try {
        const businesses = await Business.find({
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId').lean();
        
        return businesses.map(b => b.userId);
    } catch (error) {
        console.error('Error getting active payment plan user IDs:', error);
        return [];
    }
};

/**
 * Check if multiple users have active payment plans (bulk check)
 * Returns a Map of userId -> boolean
 * 
 * @param {Array<String|ObjectId>} userIds - Array of user IDs to check
 * @returns {Promise<Map<String, Boolean>>} - Map of userId to hasActivePlan boolean
 */
export const bulkCheckActivePaymentPlans = async (userIds) => {
    try {
        if (!userIds || userIds.length === 0) return new Map();
        
        // Convert to ObjectIds for query
        const objectIds = userIds.map(id => 
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );
        
        const businesses = await Business.find({
            userId: { $in: objectIds },
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        }).select('userId').lean();
        
        const activePlanUserIds = new Set(
            businesses.map(b => b.userId.toString())
        );
        
        const result = new Map();
        userIds.forEach(userId => {
            const userIdStr = userId.toString();
            result.set(userIdStr, activePlanUserIds.has(userIdStr));
        });
        
        return result;
    } catch (error) {
        console.error('Error bulk checking payment plans:', error);
        return new Map();
    }
};

/**
 * Hides COMMERCIAL posts from business accounts without an active plan.
 *
 * Selling is the paid feature, so a business on the free plan keeps its
 * ordinary presence — photos, reels, tweets — and loses only its product,
 * service and business listings from discovery.
 *
 * This used to filter by ACCOUNT rather than by post. It looked up
 * isBusinessProfile on the user and, when there was no active plan, dropped
 * every post that person had ever made, holiday photos included. The old
 * comment read "keep all non-business posts", which sounds like content type
 * but meant "posts by a non-business account" — the set it tested was a set of
 * users. That is why switching an account to a free business plan made the
 * person vanish from Explore and Search entirely.
 *
 * The distinction is already on the model and needs nothing new:
 *   postType    photo | reel | video | story | tweet   (the format)
 *   contentType normal | product | service | business  (what it is)  <- this
 *
 * Note this only affects DISCOVERY. It is applied by explore and search, not
 * by the home feed, so followers see an unpaid business account's posts either
 * way.
 *
 * @param {Array} posts - Array of post objects with userId field
 * @returns {Promise<Array>} - Filtered array of posts
 */

/** Post content that counts as selling, and so needs an active plan. */
const COMMERCIAL_CONTENT_TYPES = new Set(['product', 'service', 'business']);
export const filterBusinessPostsByPaymentPlan = async (posts, viewerId = null) => {
    // Phase 4 (#74, #78, #80): KYC and plan decide who sees commercial posts;
    // Premium authors come first. KYC_VISIBILITY_MODE=legacy restores the old
    // rule below.
    const { getSettingValue } = await import('./appSettings.utils.js');
    if ((await getSettingValue('KYC_VISIBILITY_MODE', 'enforce')) !== 'legacy') {
        const { filterCommercialPosts } = await import('./businessVisibility.utils.js');
        return filterCommercialPosts(posts, viewerId, { context: 'discovery' });
    }
    try {
        if (!posts || posts.length === 0) return [];
        
        // Extract unique user IDs from posts
        const userIds = [...new Set(posts.map(post => {
            const userId = post.userId?._id || post.userId;
            return userId ? userId.toString() : null;
        }).filter(Boolean))];
        
        if (userIds.length === 0) return posts;
        
        // Get which users have active payment plans
        const activePlanMap = await bulkCheckActivePaymentPlans(userIds);
        
        // Get which users are business accounts
        const { User } = await import('../models/user.models.js');
        const businessUsers = await User.find({
            _id: { $in: userIds },
            isBusinessProfile: true
        }).select('_id').lean();
        
        const businessUserIds = new Set(
            businessUsers.map(u => u._id.toString())
        );
        
        // Keep everything except commercial content from an unpaid business.
        return posts.filter(post => {
            const userId = post.userId?._id || post.userId;
            if (!userId) return false;

            const userIdStr = userId.toString();

            // Personal accounts are never filtered.
            if (!businessUserIds.has(userIdStr)) return true;

            // A paid business shows everything.
            if (activePlanMap.get(userIdStr) === true) return true;

            // Unpaid business: ordinary posts stay, listings do not. Anything
            // with no contentType is treated as 'normal' — the field is
            // required going forward, but older rows predate it and a missing
            // value must not silently hide somebody's photos.
            return !COMMERCIAL_CONTENT_TYPES.has(post.contentType);
        });
    } catch (error) {
        console.error('Error filtering business posts by payment plan:', error);
        // On error, return original posts to avoid breaking the feed
        return posts;
    }
};

/**
 * Get business and payment data for a set of user IDs
 * Returns an object with sets for quick lookup
 *
 * @param {Array<String|ObjectId>} userIds - Optional array of user IDs to filter
 * @returns {Promise<Object>} - Object containing activePlanUserIdsSet and businessUserIdsSet
 */
export const getBusinessPaymentData = async (userIds = null) => {
    try {
        // Get all businesses with active payment plans
        const activePaymentQuery = {
            subscriptionStatus: 'active',
            plan: { $ne: 'plan1' }
        };

        if (userIds && userIds.length > 0) {
            const objectIds = userIds.map(id =>
                typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
            );
            activePaymentQuery.userId = { $in: objectIds };
        }

        const activePaymentPlanBusinesses = await Business.find(activePaymentQuery)
            .select('userId')
            .lean();

        const activePlanUserIdsSet = new Set(
            activePaymentPlanBusinesses.map(b => b.userId.toString())
        );

        // Get all business users
        const { User } = await import('../models/user.models.js');
        const businessUserQuery = { isBusinessProfile: true };

        if (userIds && userIds.length > 0) {
            businessUserQuery._id = { $in: userIds };
        }

        const businessUsers = await User.find(businessUserQuery)
            .select('_id')
            .lean();

        const businessUserIdsSet = new Set(
            businessUsers.map(u => u._id.toString())
        );

        return {
            activePlanUserIdsSet,
            businessUserIdsSet,
            activePlanUserIds: [...activePlanUserIdsSet],
            businessUserIds: [...businessUserIdsSet]
        };
    } catch (error) {
        console.error('Error getting business payment data:', error);
        return {
            activePlanUserIdsSet: new Set(),
            businessUserIdsSet: new Set(),
            activePlanUserIds: [],
            businessUserIds: []
        };
    }
};

/**
 * Check if a post should be visible based on business payment rules
 *
 * @param {Object} post - The post object
 * @param {Set} businessUserIdsSet - Set of business user IDs
 * @param {Set} activePlanUserIdsSet - Set of user IDs with active payment plans
 * @returns {Boolean} - True if post should be visible
 */
export const isPostVisibleByPaymentRules = (post, businessUserIdsSet, activePlanUserIdsSet) => {
    const userId = post.userId?._id || post.userId;
    if (!userId) return false;

    const userIdStr = userId.toString();
    const isBusiness = businessUserIdsSet.has(userIdStr);

    // Non-business posts are always visible (subject to other privacy rules)
    if (!isBusiness) {
        return true;
    }

    // Business posts are only visible if they have an active payment plan
    return activePlanUserIdsSet.has(userIdStr);
};

/**
 * Calculate the feed priority score boost for a post based on business payment status
 *
 * @param {Object} post - The post object
 * @param {Set} businessUserIdsSet - Set of business user IDs
 * @param {Set} activePlanUserIdsSet - Set of user IDs with active payment plans
 * @returns {Number} - Priority score boost (0 for non-business, 200 for paid business)
 */
export const getBusinessPriorityBoost = (post, businessUserIdsSet, activePlanUserIdsSet) => {
    const userId = post.userId?._id || post.userId;
    if (!userId) return 0;

    const userIdStr = userId.toString();
    const isBusiness = businessUserIdsSet.has(userIdStr);
    const hasActivePlan = activePlanUserIdsSet.has(userIdStr);

    // Paid business posts get highest priority boost
    if (isBusiness && hasActivePlan) {
        return 200;
    }

    return 0;
};
