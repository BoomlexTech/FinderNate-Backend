/**
 * Per-user pinned chats (client list, 20 Nov 2026: "pin important
 * conversations to the top of the chat list").
 *
 * Kept free of imports so the rules can be unit tested without a database.
 * A chat document carries `pins: [{ userId, pinnedAt }]` (select:false): a pin
 * belongs to the person who set it and nobody else is told.
 */

/** As on Instagram and WhatsApp. */
export const MAX_PINNED_CHATS = 3;

/** When `userId` pinned `chat`, or null. */
export const pinnedAtFor = (chat, userId) => {
    if (!chat || !userId) return null;
    const id = userId.toString();
    const entry = (chat.pins || []).find((p) => p?.userId?.toString() === id);
    if (!entry) return null;
    return entry.pinnedAt ? new Date(entry.pinnedAt) : new Date(0);
};

/** { isPinned, pinnedAt } for API responses. */
export const pinFieldsFor = (chat, userId) => {
    const at = pinnedAtFor(chat, userId);
    return { isPinned: at !== null, pinnedAt: at ? at.toISOString() : null };
};

const stamp = (chat) => new Date(chat?.lastMessageAt || chat?.createdAt || 0).getTime();

/**
 * Pinned chats first, then the rest; inside each group the chat with the
 * newest message comes first. Returns a new array.
 */
export const sortChatsForUser = (chats, userId) => [...(chats || [])].sort((a, b) => {
    const pa = pinnedAtFor(a, userId) !== null ? 1 : 0;
    const pb = pinnedAtFor(b, userId) !== null ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return stamp(b) - stamp(a);
});
