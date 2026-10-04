/**
 * One-off backfill: mark feedback written before the support queue existed as
 * resolved and standard-priority, so the admin queue starts empty instead of
 * showing every historical message as an open request.
 *
 *   node src/scripts/backfillFeedbackStatus.js            dry run: prints what it would do
 *   node src/scripts/backfillFeedbackStatus.js --apply    writes the change
 *
 * Only rows with no `status` field are touched, so it is safe to run twice and
 * it never overwrites a request that has entered the queue. Nothing is deleted
 * and the original createdAt/updatedAt are left as they were.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../db/index.js';
import Feedback from '../models/feedback.models.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const LEGACY_FILTER = { status: { $exists: false } };
const LEGACY_UPDATE = { $set: { status: 'resolved', priority: 'standard', priorityRank: 0 } };

(async () => {
    try {
        await connectDB();

        const legacyCount = await Feedback.countDocuments(LEGACY_FILTER);
        const total = await Feedback.countDocuments();
        console.log(`\n${total} feedback rows, ${legacyCount} without a status.`);

        if (!apply) {
            console.log(`Dry run. With --apply, those ${legacyCount} rows would be set to`, LEGACY_UPDATE.$set);
        } else {
            const result = await Feedback.updateMany(LEGACY_FILTER, LEGACY_UPDATE, { timestamps: false });
            console.log(`Updated ${result.modifiedCount} rows to`, LEGACY_UPDATE.$set);
        }

        await mongoose.disconnect();
        process.exit(0);
    } catch (err) {
        console.error('❌ Backfill failed:', err);
        process.exit(1);
    }
})();
