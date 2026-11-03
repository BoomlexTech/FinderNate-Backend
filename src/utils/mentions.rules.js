/** Pure @mention rules behind utils/mentions.utils.js (Phase 2 #64). */

/**
 * @mentions in posts and comments (Phase 2 #64).
 *
 * The text keeps whatever the author typed; what the server decides is who
 * becomes a real mention (stored, linkable, notified). An account is
 * mentionable unless it is gone, it and the author have blocked each other,
 * or its mentionPrivacy says no:
 *   everyone  - anyone
 *   following - only accounts it follows
 *   nobody    - no one
 */

export const MAX_MENTIONS = 20;

// "@" at the start or after a character that can't be part of a username or
// an email address, then a username: letters, digits, "_" and ".".
const MENTION_RE = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g;

/** Lower-cased, de-duplicated usernames @mentioned in the given texts, in order. */
export const extractMentionUsernames = (...texts) => {
    const seen = new Set();
    for (const text of texts) {
        if (typeof text !== 'string' || !text.includes('@')) continue;
        MENTION_RE.lastIndex = 0;
        let m;
        while ((m = MENTION_RE.exec(text))) {
            seen.add(m[2].toLowerCase());
            if (seen.size >= MAX_MENTIONS) return [...seen];
        }
    }
    return [...seen];
};

/**
 * Pure rule for one candidate. `followsAuthor` is whether the candidate
 * follows the author; it only matters for 'following'.
 */
export const canBeMentioned = ({ mentionPrivacy = 'everyone', followsAuthor = false, blocked = false, isSelf = false }) => {
    if (isSelf || blocked) return false;
    if (mentionPrivacy === 'nobody') return false;
    if (mentionPrivacy === 'following') return followsAuthor === true;
    return true;
};
