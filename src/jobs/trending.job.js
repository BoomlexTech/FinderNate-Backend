import cron from 'node-cron';
import { computeTrendingTopics, computeTrendingPlaces } from '../services/trending.service.js';

/**
 * Trending topics every 30 minutes (#58) and trending near you / hot deals
 * every 3 hours (#42). Running on several API servers at once is harmless:
 * each run overwrites the same Redis keys with the same answer.
 */
export const startTrendingJobs = () => {
    cron.schedule('*/30 * * * *', () => {
        computeTrendingTopics().catch((err) => console.warn('[trending] topics failed:', err?.message));
    });
    cron.schedule('5 */3 * * *', () => {
        computeTrendingPlaces().catch((err) => console.warn('[trending] places failed:', err?.message));
    });
};
