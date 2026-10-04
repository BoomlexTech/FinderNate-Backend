import cron from 'node-cron';
import Subscription from '../models/subscription.models.js';
import { User } from '../models/user.models.js';
import { downgradeBusinessToFree } from '../controllers/subscription/activation.js';
import { announceEndingSoon, announcePlanEnded } from '../controllers/subscription/notices.js';
import { REMINDER_DAYS, istDaysUntil, settleWithin } from '../utils/subscriptionNotice.utils.js';
import { FeedCacheManager } from '../utils/cache.utils.js';
import { redisClient } from '../config/redis.config.js';

/**
 * Subscription Expiry Cron Job
 * Runs every day at 2:00 AM to check and handle expired subscriptions
 *
 * Tasks:
 * 1. Find expired subscriptions
 * 2. Update subscription status to 'expired'
 * 3. Downgrade business profiles to plan1 (free)
 * 4. Update business subscriptionStatus to 'pending'
 * 5. Invalidate cache for affected users
 * 6. Tell the user their plan has ended (notification, push and email)
 *
 * A second job, at 10:00 AM, reminds users whose plan will NOT renew that it is
 * about to end (sendExpiryReminders below).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Reminders are sent a few at a time: each one waits on a database claim, a push
// and an email, and a slow mail host should cost the loop a fraction of its users,
// not all of them. Few enough that a burst cannot swamp the mail host.
const REMINDER_CONCURRENCY = 4;

// How long the reminder job waits for Google Play to say whether a cancelled plan
// has been switched back on, before reminding on what the row says.
const PLAY_CHECK_TIMEOUT_MS = 15000;

// Helper function to handle subscription expiry
export const handleExpiredSubscriptions = async () => {
    try {

        const now = new Date();

        // Find all expired subscriptions that are still marked as 'active'
        const expiredSubscriptions = await Subscription.find({
            status: 'active',
            endDate: { $lt: now }
        });

        if (expiredSubscriptions.length === 0) {
            return {
                success: true,
                expiredCount: 0,
                message: 'No expired subscriptions found'
            };
        }


        let successCount = 0;
        let failureCount = 0;
        let reconciledCount = 0;

        // Process each expired subscription
        for (const subscription of expiredSubscriptions) {
            try {
                const userId = subscription.userId;

                // ── Google Play renews behind our back ────────────────────────
                // A Cashfree subscription past its endDate really is over: the
                // user has to come back and pay again. A Play one is the
                // opposite — Play charges the card by itself and only tells us
                // afterwards via an RTDN, and it also runs its own grace period
                // for failed payments. So a Play row whose endDate has passed
                // usually means "we have not heard yet", not "it lapsed", and
                // expiring it here would revoke a subscription the user is
                // still paying for.
                //
                // Ask Play instead and take whatever answer it gives; that call
                // extends the row when it has renewed and deactivates it when
                // it genuinely ended.
                //
                // `playPurchaseToken` is always the row's CURRENT token (a
                // replaced one is moved to retiredPlayTokens when the row is
                // rewritten), so this asks about the plan the user actually has
                // and never about one they changed away from. reconcile also
                // clears a scheduled plan switch once it has happened or the
                // subscription has ended. A plan switch whose new token we have
                // not seen yet is picked up by that token's own notification
                // or the app's verify call; Play offers no way to look it up
                // from the old token, so this job cannot find it. For the same
                // reason reconcile leaves a row whose token expired in the last
                // few minutes alone (the successor may be on its way); this
                // job is what ends it on its next run if nothing arrived.
                if (subscription.source === 'google_play') {
                    if (!subscription.playPurchaseToken) {
                        console.warn(`⚠️ Play subscription for user ${userId} has no purchase token — leaving as-is for manual review`);
                        continue;
                    }
                    const { isGooglePlayConfigured } = await import('../config/googlePlay.config.js');
                    if (!isGooglePlayConfigured()) {
                        // Never expire on our own guess when we simply cannot
                        // ask. Silence from a misconfigured server is not
                        // evidence the user stopped paying.
                        console.warn('⚠️ Google Play not configured — skipping Play subscription expiry');
                        continue;
                    }
                    const { reconcilePlaySubscription } = await import('../controllers/subscription/googlePlay.js');
                    await reconcilePlaySubscription(subscription.playPurchaseToken);
                    reconciledCount++;
                    continue;
                }

                // 1. Update subscription status to expired. Compare-and-set, like
                //    persistDeactivation: this row was read a while ago, and a
                //    renewal that landed since (the success-page verify or the
                //    webhook) must not be overwritten with 'expired' (a plain
                //    save() of this stale copy would, and would then tell a user
                //    who has just paid that their plan has ended). Matching the
                //    status and endDate we read means "still the lapsed plan we
                //    saw"; anything else is somebody else's change.
                const ended = await Subscription.findOneAndUpdate(
                    { _id: subscription._id, status: 'active', endDate: subscription.endDate },
                    { $set: { status: 'expired' } },
                    { new: true }
                );
                if (!ended) {
                    console.warn(`⚠️ Subscription for user ${userId} changed while expiring it (renewed?) — left as it is`);
                    continue;
                }

                // 2. Downgrade business profile to free plan (no-op if no Business
                //    doc). The verified tick goes too, unless KYC approved it.
                await downgradeBusinessToFree(userId);

                // 3. Invalidate feed and profile caches (subscription badge changed on expiry)
                try {
                    const { UserCacheManager } = await import('../utils/cache.utils.js');
                    await Promise.allSettled([
                        UserCacheManager.invalidateUserProfile(userId.toString()),
                        FeedCacheManager.invalidateUserFeed(userId),
                        FeedCacheManager.invalidateExploreFeed(),
                        FeedCacheManager.invalidateTrendingFeed()
                    ]);

                    // Clear Redis feed cache
                    const feedKeys = await redisClient.keys(`fn:user:${userId}:feed:*`);
                    if (feedKeys.length > 0) {
                        await redisClient.del(...feedKeys);
                    }

                } catch (cacheError) {
                    console.error(`⚠️ Cache invalidation failed for user ${userId}:`, cacheError.message);
                    // Don't throw - cache invalidation failure shouldn't block the expiry process
                }

                // 4. Tell the user. Detached and best-effort: it can never fail the
                //    expiry above. (A Play row never gets here; reconcile ended it
                //    through persistDeactivation, which does the same.)
                announcePlanEnded(ended);

                successCount++;

            } catch (error) {
                failureCount++;
                console.error(`❌ Failed to process subscription for user ${subscription.userId}:`, error);
            }
        }

        const result = {
            success: true,
            expiredCount: expiredSubscriptions.length,
            successCount,
            failureCount,
            reconciledCount,
            message: `Processed ${successCount} expired subscriptions successfully, ` +
                     `${reconciledCount} Google Play subscriptions reconciled with the store, ` +
                     `${failureCount} failures`
        };

        return result;

    } catch (error) {
        console.error('❌ Subscription expiry job failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Reminds users whose plan will NOT renew that it is about to end: 7, 3 and 1
 * calendar days (in India) before the end date, in-app and by push, and by email
 * at 7 and 1.
 *
 * Who is reminded: an active plan that nobody will charge again. That is every
 * website (Cashfree) plan, which is one paid month, and a Google Play plan whose
 * renewal the user has switched off. A Play plan that renews is never reminded:
 * Play itself tells those users, and a "your plan ends" for a plan that is about
 * to renew would be wrong. A legacy row has no `source` at all, so the query
 * excludes "Play and renewing" instead of asking for "cashfree".
 *
 * Safe to run twice, or from two instances at once: each reminder is claimed with
 * one atomic update before it is sent (announceEndingSoon), so a re-run, a
 * restart or a second server sends nothing more. Reminders are keyed by the end
 * date they counted down to, so a renewal (which moves the end date) starts a
 * fresh countdown on its own. A run that is missed on the exact day is not made
 * up the next day: that reminder would say the wrong number of days.
 *
 * A Google Play plan we store as cancelled is checked with Play first: the user
 * may have switched renewal back on without that reaching us, and a "resubscribe
 * to keep it" for a plan that renews is exactly the message this must never send.
 * When Play cannot be asked the stored value stands.
 *
 * One bad row (a deleted user, a failed write) is logged and skipped; it cannot
 * stop the rows after it. Rows are worked REMINDER_CONCURRENCY at a time, and a
 * push or email that hangs is not waited for beyond SUBSCRIPTION_SEND_TIMEOUT_MS (notification.controllers.js).
 *
 * [now] exists for tests, which need to run "10:00 IST on the 13th"; the cron
 * never passes it. Returns a count of what happened, which nothing relies on.
 */
export const sendExpiryReminders = async ({ now = new Date() } = {}) => {
    const summary = { due: 0, sent: 0, alreadySent: 0, skipped: 0, failed: 0, renewing: 0 };

    try {
        // One day wider than the largest reminder: at 10:00 a plan that ends late
        // on the evening of the 7th calendar day is still seven and a half days
        // away, and the exact count is worked out per row below.
        const horizon = new Date(now.getTime() + (Math.max(...REMINDER_DAYS) + 1) * DAY_MS);

        const upcoming = await Subscription.find({
            status: 'active',
            endDate: { $gt: now, $lte: horizon },
            $nor: [{ source: 'google_play', autoRenew: true }]
        });

        const remind = async (subscription) => {
            try {
                const daysLeft = istDaysUntil(subscription.endDate, now);
                if (!REMINDER_DAYS.includes(daysLeft)) return;
                if (subscription.source === 'google_play' && subscription.autoRenew === true) return;

                // Only asked of Play for a day a reminder is due, so this is a
                // handful of calls a day, not one per Play subscriber.
                if (subscription.source === 'google_play') {
                    const { playConfirmsRenewal } = await import('../controllers/subscription/googlePlay.js');
                    const renews = await settleWithin(
                        playConfirmsRenewal(subscription),
                        PLAY_CHECK_TIMEOUT_MS,
                        () => console.warn(`⚠️ Google Play did not answer for user ${subscription.userId} in ${PLAY_CHECK_TIMEOUT_MS} ms — reminding on the stored state`)
                    );
                    if (renews) {
                        summary.renewing++;
                        return;
                    }
                }

                summary.due++;
                const outcome = await announceEndingSoon(subscription, daysLeft);
                if (outcome === 'sent') summary.sent++;
                else if (outcome === 'unclaimed') summary.alreadySent++;
                else if (outcome === 'skipped') summary.skipped++;
                else summary.failed++;
            } catch (error) {
                summary.failed++;
                console.error(`❌ Expiry reminder failed for user ${subscription.userId}:`, error?.message || error);
            }
        };

        // A few workers draining one queue; remind() never rejects.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(REMINDER_CONCURRENCY, upcoming.length) }, async () => {
            while (next < upcoming.length) await remind(upcoming[next++]);
        }));

        if (summary.sent > 0 || summary.failed > 0) {
            console.log(`📣 Expiry reminders: ${summary.sent} sent, ${summary.alreadySent} already sent, ${summary.skipped} skipped, ${summary.failed} failed`);
        }
        return { success: true, ...summary };
    } catch (error) {
        console.error('❌ Failed to send expiry reminders:', error);
        return { success: false, error: error.message, ...summary };
    }
};

/**
 * Start the cron job
 * Schedule: Every day at 2:00 AM
 */
export const startSubscriptionExpiryJob = () => {
    // Run every day at 2:00 AM (0 2 * * *)
    const expiryJob = cron.schedule('0 2 * * *', async () => {
        console.log('⏰ [Cron] Subscription expiry job triggered');
        await handleExpiredSubscriptions();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // Run reminder check every day at 10:00 AM (0 10 * * *). Once a day matters:
    // the reminders count calendar days (see istDaysUntil).
    const reminderJob = cron.schedule('0 10 * * *', async () => {
        console.log('⏰ [Cron] Subscription reminder job triggered');
        await sendExpiryReminders();
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    console.log('✅ [Cron] Subscription expiry job scheduled (daily at 2:00 AM IST)');
    console.log('✅ [Cron] Subscription reminder job scheduled (daily at 10:00 AM IST)');

    return { expiryJob, reminderJob };
};

// For testing purposes - run immediately
export const runExpiryCheckNow = async () => {
    return await handleExpiredSubscriptions();
};
