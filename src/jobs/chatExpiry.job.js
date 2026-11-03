import cron from 'node-cron';
import Message from '../models/message.models.js';
import socketManager from '../config/socket.js';
import { deleteFromBunny, isBunnyUrl } from '../utils/bunny.js';

/**
 * Chat clean-up (Phase 3):
 *  - #37 disappearing messages: deletes messages whose timer has run out,
 *    with their media. They're already hidden from every read the moment they
 *    expire; this removes them for good.
 *  - #48 view-once: deletes the media file a few minutes after it was opened,
 *    or 14 days after sending if nobody opened it.
 *
 * Media is only deleted when no other message still uses the same file
 * (a forwarded copy points at the same link).
 */
const BATCH = 500;

const mediaOf = (m) => [m.mediaUrl, ...(m.e2eeBlobUrls || [])].filter((u) => u && isBunnyUrl(u));

const emit = (chatId, event, data) => {
    if (socketManager.isReady()) socketManager.emitToChat(String(chatId), event, data);
};

/** Deletes files that no message outside `exceptIds` still points at. */
const deleteUnusedMedia = async (urls, exceptIds) => {
    const unique = [...new Set(urls)];
    if (!unique.length) return 0;
    const stillUsed = await Message.find({
        _id: { $nin: exceptIds },
        $or: [{ mediaUrl: { $in: unique } }, { e2eeBlobUrls: { $in: unique } }],
    }).select('mediaUrl e2eeBlobUrls').lean();
    const keep = new Set(stillUsed.flatMap(mediaOf));
    let deleted = 0;
    for (const url of unique) {
        if (keep.has(url)) continue;
        try {
            await deleteFromBunny(url);
            deleted += 1;
        } catch (err) {
            console.warn(`[chat-expiry] media delete failed for ${url}: ${err?.message}`);
        }
    }
    return deleted;
};

export const purgeExpiredMessages = async (now = new Date()) => {
    const expired = await Message.find({ expiresAt: { $ne: null, $lte: now } })
        .select('_id chatId mediaUrl e2eeBlobUrls')
        .limit(BATCH)
        .lean();
    if (!expired.length) return 0;

    const ids = expired.map((m) => m._id);
    await Message.deleteMany({ _id: { $in: ids } });
    await deleteUnusedMedia(expired.flatMap(mediaOf), ids);

    const byChat = new Map();
    for (const m of expired) {
        const k = String(m.chatId);
        if (!byChat.has(k)) byChat.set(k, []);
        byChat.get(k).push(String(m._id));
    }
    for (const [chatId, messageIds] of byChat) emit(chatId, 'messages_expired', { chatId, messageIds });
    return expired.length;
};

export const purgeViewOnceMedia = async (now = new Date()) => {
    const due = await Message.find({ viewOnce: true, viewOnceMediaDeleteAt: { $ne: null, $lte: now } })
        .select('_id chatId mediaUrl e2eeBlobUrls viewOnceOpenedBy')
        .limit(BATCH)
        .lean();
    if (!due.length) return 0;

    const ids = due.map((m) => m._id);
    await deleteUnusedMedia(due.flatMap(mediaOf), ids);
    for (const m of due) {
        const unopened = !(m.viewOnceOpenedBy || []).length;
        await Message.updateOne(
            { _id: m._id },
            {
                $set: { mediaUrl: null, viewOnceMediaDeleteAt: null, ...(unopened ? { viewOnceExpired: true } : {}) },
                $unset: { e2ee: 1, e2eeBlobUrls: 1 },
            }
        );
        if (unopened) emit(m.chatId, 'view_once_expired', { chatId: String(m.chatId), messageId: String(m._id) });
    }
    return due.length;
};

let running = false;
export const runChatExpiry = async () => {
    if (running) return;
    running = true;
    try {
        const now = new Date();
        const [a, b] = [await purgeExpiredMessages(now), await purgeViewOnceMedia(now)];
        if (a || b) console.log(`[chat-expiry] removed ${a} expired message(s), ${b} view-once file(s)`);
    } catch (err) {
        console.error('[chat-expiry] run failed:', err?.message || err);
    } finally {
        running = false;
    }
};

export const startChatExpiryJob = () => {
    // Every 5 minutes. Expired messages are hidden at once anyway.
    cron.schedule('*/5 * * * *', () => { runChatExpiry(); });
};
