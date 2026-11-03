import cron from 'node-cron';
import BinItem from '../models/binItem.models.js';
import { purgeBinItem } from '../utils/bin.utils.js';

/**
 * Daily purge of Bin items older than their retention (Phase 2 #15).
 *
 * Each row is claimed atomically first, so two API servers never purge the
 * same item; a claim older than an hour is treated as abandoned (the worker
 * died) and can be taken again. A failed media delete releases the claim and
 * the row is retried the next day.
 */
const CLAIM_STALE_MS = 60 * 60 * 1000;
const BATCH = 200;

export const runBinPurge = async () => {
    const now = new Date();
    let purged = 0;
    for (let i = 0; i < BATCH; i += 1) {
        const item = await BinItem.findOneAndUpdate(
            {
                purgeAfter: { $lte: now },
                $or: [{ purgeClaimedAt: null }, { purgeClaimedAt: { $lte: new Date(Date.now() - CLAIM_STALE_MS) } }],
            },
            { $set: { purgeClaimedAt: new Date() } },
            { new: true },
        );
        if (!item) break;
        try {
            await purgeBinItem(item);
            purged += 1;
        } catch (err) {
            console.warn(`[bin] purge of ${item._id} failed, will retry: ${err?.message}`);
            await BinItem.updateOne({ _id: item._id }, { $set: { purgeClaimedAt: null } });
        }
    }
    if (purged) console.log(`[bin] purged ${purged} item(s)`);
    return purged;
};

export const startBinPurgeJob = () => {
    // 03:20 IST every day, a quiet hour.
    cron.schedule('20 3 * * *', () => { runBinPurge().catch((err) => console.error('[bin] purge run failed:', err?.message)); },
        { timezone: 'Asia/Kolkata' });
};
