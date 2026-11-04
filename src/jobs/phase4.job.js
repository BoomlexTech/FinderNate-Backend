import cron from 'node-cron';
import { runAdLifecycle } from '../controllers/ads.controllers.js';
import { runListingExpiry } from '../controllers/listings.controllers.js';
import { reconcilePendingPlatformPayments } from '../controllers/platformPayments.controllers.js';
import { runBusinessViewDigest, runKycMaintenance, runPlusReminders } from '../controllers/businessGrowth.controllers.js';

/**
 * Phase 4 background work:
 *  - ads start and stop on time (#27)                       every 5 minutes
 *  - missed Cashfree confirmations are settled             every 10 minutes
 *  - paid listings expire (#80)                             hourly
 *  - stored visibility tiers and the Q10 recheck (#74)      hourly
 *  - "people viewed your profile" digest (#75)             daily 20:05 IST
 *  - Findernate Plus reminders (#77)                        daily 10:20 IST
 */
const safe = (label, fn) => () => fn().catch((e) => console.error(`[phase4] ${label} failed:`, e?.message || e));

export const startPhase4Jobs = () => {
    cron.schedule('*/5 * * * *', safe('ads', runAdLifecycle));
    cron.schedule('*/10 * * * *', safe('payments', reconcilePendingPlatformPayments));
    cron.schedule('15 * * * *', safe('listings', runListingExpiry));
    cron.schedule('35 * * * *', safe('kyc', runKycMaintenance));
    cron.schedule('5 20 * * *', safe('views digest', runBusinessViewDigest), { timezone: 'Asia/Kolkata' });
    cron.schedule('20 10 * * *', safe('plus reminders', runPlusReminders), { timezone: 'Asia/Kolkata' });
};
