import fsp from 'node:fs/promises';
import path from 'node:path';
import cron from 'node-cron';
import MediaEdit from '../models/mediaEdit.models.js';
import Sound from '../models/sound.models.js';
import { runCountdownReminders } from '../controllers/storyStickers.controllers.js';
import { releaseEditResult } from '../controllers/edits.controllers.js';
import { editsRoot, removeWorkDir } from '../services/mediaRender.service.js';
import { soundIsInUse, deleteSoundForGood, retireOriginalSound } from '../services/sounds.service.js';
import Post from '../models/userPost.models.js';
import BinItem from '../models/binItem.models.js';

/**
 * Phase 5 background work:
 *  - story countdown reminders come due (#47)              every 5 minutes
 *  - edits nobody used are cleaned up, temp files swept    hourly
 *  - sounds whose vibe is gone, and removed sounds, tidied daily at 03:40 IST
 */

const HOUR = 3600 * 1000;

/** Unused results older than 48 hours, failed work folders, stray uploads. */
export const runEditCleanup = async () => {
    const now = Date.now();
    let released = 0;
    let swept = 0;

    const stale = await MediaEdit.find({ status: 'done', usedAt: null, cleanedAt: null, finishedAt: { $lte: new Date(now - 48 * HOUR) } }).limit(200);
    for (const edit of stale) {
        await releaseEditResult(edit.toObject()); // leaves anything a post or story still uses
        edit.status = 'expired';
        edit.cleanedAt = new Date();
        await edit.save();
        released++;
    }

    // Work that never finished (the server restarted mid-render): give up after two hours.
    const stuck = await MediaEdit.find({ status: { $in: ['queued', 'processing'] }, updatedAt: { $lte: new Date(now - 2 * HOUR) } }).limit(100);
    for (const edit of stuck) {
        edit.status = 'failed';
        edit.error = 'This took too long and was stopped. Please try again.';
        edit.finishedAt = new Date();
        await edit.save();
        await removeWorkDir(edit.workDir);
    }

    // Anything left in the temp folder for more than 6 hours belongs to nobody.
    const root = editsRoot();
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        if (entry.name === 'incoming') {
            const files = await fsp.readdir(full).catch(() => []);
            for (const f of files) {
                const st = await fsp.stat(path.join(full, f)).catch(() => null);
                if (st && now - st.mtimeMs > 2 * HOUR) { await fsp.rm(path.join(full, f), { force: true }); swept++; }
            }
        } else if (now - stat.mtimeMs > 6 * HOUR) {
            await removeWorkDir(full);
            swept++;
        }
    }

    // The records themselves are not needed after two weeks.
    await MediaEdit.deleteMany({ status: { $in: ['expired', 'failed'] }, updatedAt: { $lte: new Date(now - 14 * 24 * HOUR) } });
    return { released, stuck: stuck.length, swept };
};

/**
 * Original audio whose vibe no longer exists (deleted for good, or never
 * restored) and removed sounds nobody plays any more.
 */
export const runSoundMaintenance = async () => {
    let retired = 0;
    let deleted = 0;
    const originals = await Sound.find({ source: 'original', status: { $in: ['active', 'held'] } }).select('sourcePostId status').limit(2000).lean();
    for (const s of originals) {
        if (!s.sourcePostId) continue;
        const [live, binned] = await Promise.all([Post.exists({ _id: s.sourcePostId }), BinItem.exists({ originalId: s.sourcePostId })]);
        if (!live && !binned) { await retireOriginalSound(s.sourcePostId); retired++; }
    }
    const removed = await Sound.find({ status: 'removed' }).limit(200).lean();
    for (const s of removed) {
        if (!(await soundIsInUse(s._id))) { await deleteSoundForGood(s); deleted++; }
    }
    return { retired, deleted };
};

const safe = (label, fn) => () => fn().catch((e) => console.error(`[phase5] ${label} failed:`, e?.message || e));

export const startPhase5Jobs = () => {
    cron.schedule('*/5 * * * *', safe('countdown reminders', runCountdownReminders));
    cron.schedule('25 * * * *', safe('edit cleanup', runEditCleanup));
    cron.schedule('40 3 * * *', safe('sound maintenance', runSoundMaintenance), { timezone: 'Asia/Kolkata' });
};
