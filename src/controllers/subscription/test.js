import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import Subscription from '../../models/subscription.models.js';
import { User } from '../../models/user.models.js';

const PLAN_TO_BUSINESS_PLAN = {
    free: 'plan1',
    basic: 'basic',
    small_business: 'plan2',
    corporate: 'plan3'
};

/**
 * @deprecated TEST ONLY — simulates subscription upgrade without payment.
 * Use createSubscriptionOrder + verifySubscriptionPayment in production.
 */
export const testUpgradeSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { plan } = req.body;

    const validPlans = ['free', 'basic', 'small_business', 'corporate'];
    if (!plan || !validPlans.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${validPlans.join(', ')}`);
    }

    const user = await User.findById(userId);
    if (!user) throw new ApiError(404, 'User not found');

    let subscription = await Subscription.findOne({ userId });

    const now = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    if (plan === 'free') {
        if (subscription) {
            await Subscription.deleteOne({ userId });
            subscription = null;
        }
    } else {
        if (subscription) {
            subscription.plan = plan;
            subscription.status = 'active';
            subscription.startDate = now;
            subscription.endDate = endDate;
            await subscription.save();
        } else {
            subscription = await Subscription.create({
                userId,
                plan,
                status: 'active',
                startDate: now,
                endDate
            });
        }
    }

    const Business = (await import('../../models/business.models.js')).default;
    const updateFields = plan === 'free'
        ? { plan: PLAN_TO_BUSINESS_PLAN[plan], subscriptionStatus: 'pending' }
        : { plan: PLAN_TO_BUSINESS_PLAN[plan], subscriptionStatus: 'active', isVerified: true };

    const business = await Business.findOneAndUpdate(
        { userId },
        { $set: updateFields },
        { upsert: true, new: true }
    );

    try {
        const { FeedCacheManager, UserCacheManager } = await import('../../utils/cache.utils.js');
        await Promise.allSettled([
            UserCacheManager.invalidateUserProfile(userId.toString()),
            FeedCacheManager.invalidateUserFeed(userId),
            FeedCacheManager.invalidateExploreFeed(),
            FeedCacheManager.invalidateTrendingFeed()
        ]);
        const { redisClient } = await import('../../config/redis.config.js');
        const feedKeys = await redisClient.keys('fn:user:*:feed:*');
        if (feedKeys.length > 0) await redisClient.del(...feedKeys);
    } catch (cacheError) {
        console.error('Cache invalidation error:', cacheError);
    }

    const hasCallingAccess = plan !== 'free';

    res.status(200).json(
        new ApiResponse(200, {
            subscription,
            business: business ? { plan: business.plan, subscriptionStatus: business.subscriptionStatus } : null,
            tier: plan,
            hasCallingAccess,
            message: plan === 'free'
                ? 'Successfully downgraded to free plan. Subscription record removed.'
                : `Successfully upgraded to ${plan} plan (TEST MODE - No payment required)`,
            note: 'This is a test endpoint. In production, payment will be required.'
        }, 'Subscription updated successfully (TEST MODE)')
    );
});
