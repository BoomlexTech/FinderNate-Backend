import Subscription from '../models/subscription.models.js';
import { badgeForPlan } from '../constants/subscriptionBadges.js';
import mongoose from 'mongoose';

/**
 * Get subscription badge for a user based on their subscription status
 * @param {Object|String} user - User object or userId
 * @returns {Object|null} Badge object or null if no badge
 */
export const getUserBadge = async (user) => {
    // Get userId
    const userId = typeof user === 'object' ? (user._id || user.id) : user;

    // Check active subscription
    const subscription = await Subscription.findOne({
        userId: userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });

    if (!subscription || subscription.plan === 'free') {
        return null; // No badge for free users
    }

    return badgeForPlan(subscription.plan);
};

/**
 * Add subscription badge to a single user object
 * @param {Object} userObj - User object (can be lean or document)
 * @returns {Object} User object with badge added
 */
export const addBadgeToUser = async (userObj) => {
    if (!userObj) return null;

    // Convert to plain object if it's a mongoose document
    const user = userObj.toObject ? userObj.toObject() : { ...userObj };

    // Get the badge
    const badge = await getUserBadge(user);

    // Add badge to user object
    user.subscriptionBadge = badge;

    return user;
};

/**
 * Add subscription badges to an array of user objects
 * @param {Array} users - Array of user objects
 * @returns {Array} Array of user objects with badges added
 */
export const addBadgesToUsers = async (users) => {
    if (!users || !Array.isArray(users)) return [];

    // Get all user IDs and their business profile status
    const userMap = new Map();
    users.forEach(user => {
        if (user) {
            const userId = (user._id || user.id)?.toString();
            if (userId) {
                userMap.set(userId, {
                    isBusinessProfile: user.isBusinessProfile || false
                });
            }
        }
    });

    const userIds = Array.from(userMap.keys()).map(id => new mongoose.Types.ObjectId(id));

    // Get all active subscriptions in one query
    const subscriptions = await Subscription.find({
        userId: { $in: userIds },
        status: 'active',
        endDate: { $gt: new Date() }
    }).lean();

    // Create a map of userId -> subscription plan
    const subscriptionMap = new Map();
    subscriptions.forEach(sub => {
        subscriptionMap.set(sub.userId.toString(), sub.plan);
    });

    // Add badges to all users based on their subscription plan
    return users.map(userObj => {
        if (!userObj) return null;

        // Convert to plain object if it's a mongoose document
        const user = userObj.toObject ? userObj.toObject() : { ...userObj };
        const userId = (user._id || user.id)?.toString();

        if (!userId) return user;

        // Get subscription plan for this user
        const plan = subscriptionMap.get(userId);

        // Add badge based on subscription plan (not isBusinessProfile)
        user.subscriptionBadge = badgeForPlan(plan);

        return user;
    });
};

/**
 * Add subscription badge to nested user objects in posts/comments
 * @param {Array} items - Array of posts/comments with populated userId
 * @returns {Array} Array with badges added to nested user objects
 */
export const addBadgesToNestedUsers = async (items) => {
    if (!items || !Array.isArray(items)) return [];

    // Extract all unique users (including userId and replyToUserId for comments)
    const userMap = new Map();
    items.forEach(item => {
        if (item && item.userId) {
            const userId = (item.userId._id || item.userId.id || item.userId)?.toString();
            if (userId && typeof item.userId === 'object') {
                userMap.set(userId, item.userId);
            }
        }
        // Also extract replyToUserId for comments
        if (item && item.replyToUserId) {
            const replyToUserId = (item.replyToUserId._id || item.replyToUserId.id || item.replyToUserId)?.toString();
            if (replyToUserId && typeof item.replyToUserId === 'object') {
                userMap.set(replyToUserId, item.replyToUserId);
            }
        }
    });

    // Get badges for all users
    const users = Array.from(userMap.values());
    const usersWithBadges = await addBadgesToUsers(users);

    // Create a map of userId -> user with badge
    const badgeMap = new Map();
    usersWithBadges.forEach(user => {
        if (user) {
            const userId = (user._id || user.id)?.toString();
            if (userId) {
                badgeMap.set(userId, user);
            }
        }
    });

    // Update items with badged users
    return items.map(item => {
        if (!item) return item;

        // Update userId with badge
        if (item.userId && typeof item.userId === 'object') {
            const userId = (item.userId._id || item.userId.id)?.toString();
            if (userId && badgeMap.has(userId)) {
                item.userId = badgeMap.get(userId);
            }
        }

        // Update replyToUserId with badge (for comments)
        if (item.replyToUserId && typeof item.replyToUserId === 'object') {
            const replyToUserId = (item.replyToUserId._id || item.replyToUserId.id)?.toString();
            if (replyToUserId && badgeMap.has(replyToUserId)) {
                item.replyToUserId = badgeMap.get(replyToUserId);
            }
        }

        return item;
    });
};
