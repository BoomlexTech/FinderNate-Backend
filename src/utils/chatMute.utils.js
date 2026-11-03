/**
 * Per-user chat mute rules (Phase 2 #38).
 *
 * Kept free of imports so the rules can be unit tested without a database.
 * A chat document carries `mutes: [{ userId, until }]` (select:false) and the
 * legacy `mutedBy: [userId]`, which counts as a mute with no end time.
 */

export const MUTE_DURATIONS = Object.freeze({
    '8h': 8 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
    always: null,
});

/**
 * When `userId`'s mute on `chat` ends: a Date, `null` for "until turned off",
 * or `undefined` when the chat is not muted for them (expired mutes included).
 */
export const muteStateFor = (chat, userId, now = new Date()) => {
    if (!chat || !userId) return undefined;
    const id = userId.toString();
    if ((chat.mutedBy || []).some((u) => u?.toString() === id)) return null;
    const entry = (chat.mutes || []).find((m) => m?.userId?.toString() === id);
    if (!entry) return undefined;
    if (entry.until == null) return null;
    return new Date(entry.until) > now ? new Date(entry.until) : undefined;
};

export const isChatMutedFor = (chat, userId, now = new Date()) =>
    muteStateFor(chat, userId, now) !== undefined;

/** { isMuted, mutedUntil } for API responses; mutedUntil is null when muted with no end. */
export const muteFieldsFor = (chat, userId, now = new Date()) => {
    const state = muteStateFor(chat, userId, now);
    return { isMuted: state !== undefined, mutedUntil: state instanceof Date ? state.toISOString() : null };
};
