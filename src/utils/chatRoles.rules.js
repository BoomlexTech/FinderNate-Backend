/**
 * Pure chat rules for Phase 3: group roles (#21), disappearing messages (#37)
 * and view-once media (#48). No database or Redis imports, so unit tests can
 * load this file directly.
 */

const idOf = (v) => (v && v._id ? String(v._id) : v == null ? '' : String(v));
const hasId = (list, id) => (list || []).some((x) => idOf(x) === String(id));

// ─── Group roles (#21) ──────────────────────────────────────────────────────

export const ROLES = Object.freeze({ OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member' });

export const MAX_GROUP_MEMBERS = 256;

/** When each member joined. Groups created before Phase 3 have no record, so
 *  their join order falls back to the participants array order. */
export const joinedAtOf = (chat, userId) => {
    const row = (chat?.memberSince || []).find((m) => idOf(m.userId) === String(userId));
    return row?.joinedAt ? new Date(row.joinedAt) : null;
};

/** Members ordered from longest-serving to newest. */
export const bySeniority = (chat, ids) => {
    const order = (chat?.participants || []).map(idOf);
    return [...ids].map(String).sort((a, b) => {
        const ja = joinedAtOf(chat, a);
        const jb = joinedAtOf(chat, b);
        if (ja && jb && ja.getTime() !== jb.getTime()) return ja - jb;
        if (ja && !jb) return 1; // no record = joined before records existed
        if (!ja && jb) return -1;
        return order.indexOf(a) - order.indexOf(b);
    });
};

/**
 * The group's owner. `ownerId` is new; older groups only have `createdBy`, and
 * the old leaveGroup let the creator leave. So: ownerId if still a member,
 * else createdBy if still a member, else the longest-serving admin, else the
 * longest-serving member.
 */
export const effectiveOwnerId = (chat) => {
    if (!chat || chat.chatType !== 'group') return null;
    const participants = (chat.participants || []).map(idOf);
    if (chat.ownerId && participants.includes(idOf(chat.ownerId))) return idOf(chat.ownerId);
    if (chat.createdBy && participants.includes(idOf(chat.createdBy))) return idOf(chat.createdBy);
    const admins = (chat.admins || []).map(idOf).filter((a) => participants.includes(a));
    if (admins.length) return bySeniority(chat, admins)[0];
    return participants.length ? bySeniority(chat, participants)[0] : null;
};

export const roleOf = (chat, userId) => {
    if (!chat || !userId) return null;
    if (!hasId(chat.participants, userId)) return null;
    if (chat.chatType !== 'group') return ROLES.MEMBER;
    if (effectiveOwnerId(chat) === String(userId)) return ROLES.OWNER;
    if (hasId(chat.admins, userId)) return ROLES.ADMIN;
    return ROLES.MEMBER;
};

/**
 * Permission table from the plan (§5.3):
 *
 * | Action                      | Owner | Admin | Member |
 * | Add members                 |  yes  |  yes  |   no   |
 * | Remove or block members     |  yes  |  yes  |   no   |
 * | Remove or block admins      |  yes  |  no   |   no   |
 * | Make or remove admins       |  yes  |  no   |   no   |
 * | Remove or block the owner   |  no   |  no   |   no   |
 * | Delete the group            |  yes  |  no   |   no   |
 *
 * Editing the name, picture and disappearing timer follows "add members"
 * (owner and admins).
 *
 * Returns null when allowed, or a message saying why not.
 */
export const checkGroupPermission = (chat, actorId, action, targetId = null) => {
    if (!chat || chat.chatType !== 'group') return 'This only works in group chats';
    const actorRole = roleOf(chat, actorId);
    if (!actorRole) return 'You are not a member of this group';
    const isManager = actorRole === ROLES.OWNER || actorRole === ROLES.ADMIN;

    switch (action) {
        case 'add_members':
        case 'edit_info':
        case 'set_timer':
            return isManager ? null : 'Only the group owner and admins can do this';
        case 'remove_member':
        case 'block_member': {
            if (!isManager) return 'Only the group owner and admins can remove people';
            if (String(targetId) === String(actorId)) return 'Use "Leave group" to remove yourself';
            const targetRole = roleOf(chat, targetId);
            // A blocked user who already left can still be blocked by a manager.
            if (!targetRole) return action === 'block_member' ? null : 'That person is not in this group';
            if (targetRole === ROLES.OWNER) return 'The group owner cannot be removed';
            if (targetRole === ROLES.ADMIN && actorRole !== ROLES.OWNER) return 'Only the group owner can remove an admin';
            return null;
        }
        case 'unblock_member':
            return isManager ? null : 'Only the group owner and admins can unblock people';
        case 'make_admin':
        case 'remove_admin': {
            if (actorRole !== ROLES.OWNER) return 'Only the group owner can change admins';
            const targetRole = roleOf(chat, targetId);
            if (!targetRole) return 'That person is not in this group';
            if (targetRole === ROLES.OWNER) return 'The owner is already in charge of the group';
            if (action === 'make_admin' && targetRole === ROLES.ADMIN) return 'Already an admin';
            if (action === 'remove_admin' && targetRole !== ROLES.ADMIN) return 'Not an admin';
            return null;
        }
        case 'transfer_owner': {
            if (actorRole !== ROLES.OWNER) return 'Only the group owner can hand over the group';
            if (String(targetId) === String(actorId)) return 'You already own this group';
            return roleOf(chat, targetId) ? null : 'That person is not in this group';
        }
        case 'delete_group':
            return actorRole === ROLES.OWNER ? null : 'Only the group owner can delete the group';
        default:
            return 'Unknown action';
    }
};

/** Who owns the group once `leavingId` leaves: the longest-serving admin, or
 *  the longest-serving member when there are no admins. */
export const nextOwnerAfterLeave = (chat, leavingId) => {
    const remaining = (chat?.participants || []).map(idOf).filter((p) => p !== String(leavingId));
    if (!remaining.length) return null;
    const admins = (chat.admins || []).map(idOf).filter((a) => remaining.includes(a));
    if (admins.length) return bySeniority(chat, admins)[0];
    return bySeniority(chat, remaining)[0];
};

// ─── System messages ────────────────────────────────────────────────────────

const nameOf = (u) => (u && (u.fullName || u.username)) || 'Someone';

const DURATION_LABELS = { 86400: '24 hours', 604800: '7 days', 7776000: '90 days' };

/** The text stored in `message` for a system event, so older clients that
 *  only know `message` still show something sensible. */
export const systemMessageText = (action, actor, targets = [], data = {}) => {
    const a = nameOf(actor);
    const t = targets.map(nameOf);
    const list = t.length <= 2 ? t.join(' and ') : `${t.slice(0, 2).join(', ')} and ${t.length - 2} more`;
    switch (action) {
        case 'group_created': return `${a} created the group`;
        case 'members_added': return `${a} added ${list}`;
        case 'member_removed': return `${a} removed ${list}`;
        case 'member_blocked': return `${a} removed and blocked ${list}`;
        case 'member_unblocked': return `${a} unblocked ${list}`;
        case 'member_left': return `${a} left`;
        case 'admin_added': return `${a} made ${list} an admin`;
        case 'admin_removed': return `${a} removed ${list} as admin`;
        case 'owner_changed':
            return data.reason === 'left'
                ? `${list} is now the group owner`
                : `${a} made ${list} the group owner`;
        case 'disappearing_on':
            return `${a} turned on disappearing messages. New messages will disappear ${DURATION_LABELS[data.seconds] || 'after a while'} after they're sent.`;
        case 'disappearing_off': return `${a} turned off disappearing messages`;
        case 'e2ee_on': return 'Messages in this chat are now end-to-end encrypted. Nobody outside this chat, not even Findernate, can read them.';
        default: return a;
    }
};

// ─── Disappearing messages (#37) ────────────────────────────────────────────

export const DISAPPEARING_OPTIONS = Object.freeze([0, 86400, 604800, 7776000]);

/** Accepts seconds or a label ('off', '24h', '7d', '90d'). Returns seconds,
 *  or null for an invalid value. */
export const parseDisappearingSeconds = (value) => {
    const labels = { off: 0, '0': 0, '24h': 86400, '1d': 86400, '7d': 604800, '90d': 7776000 };
    if (typeof value === 'string' && value.trim().toLowerCase() in labels) {
        return labels[value.trim().toLowerCase()];
    }
    const n = Number(value);
    return DISAPPEARING_OPTIONS.includes(n) ? n : null;
};

/** Records that must survive a disappearing timer: money, orders, calls and
 *  the group's own system history. */
export const NEVER_EXPIRING_TYPES = new Set(['payment_link', 'checkout', 'order_update', 'call', 'system']);

export const expiryFor = (chat, messageType, sentAt = new Date()) => {
    const seconds = Number(chat?.disappearing?.seconds) || 0;
    if (!seconds || NEVER_EXPIRING_TYPES.has(messageType)) return null;
    return new Date(new Date(sentAt).getTime() + seconds * 1000);
};

/** Query fragment that hides messages whose timer has run out, so they vanish
 *  on time even before the purge job deletes them. */
export const notExpiredFilter = (now = new Date()) => ({
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
});

// ─── View-once (#48) ────────────────────────────────────────────────────────

/** Unopened view-once media is removed after this long. */
export const VIEW_ONCE_UNOPENED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** After the first open the media file stays up just long enough to load. */
export const VIEW_ONCE_OPEN_GRACE_MS = 5 * 60 * 1000;

export const parseBool = (v) => v === true || v === 'true' || v === '1' || v === 1;

/** Only photos and videos (plain or encrypted) in direct chats can be view-once. */
export const viewOnceAllowed = (chat, messageType) =>
    chat?.chatType === 'direct' && ['image', 'video', 'encrypted'].includes(messageType);

/**
 * What one viewer may see of a view-once message in a list or socket payload.
 * The media link (and the encrypted envelope, which holds it for E2EE chats)
 * is never included; the recipient gets it once from the open endpoint.
 */
export const redactViewOnce = (msg, viewerId) => {
    if (!msg || !msg.viewOnce) return msg;
    const opened = (msg.viewOnceOpenedBy || []).some((o) => idOf(o.userId) === String(viewerId));
    const anyOpened = (msg.viewOnceOpenedBy || []).length > 0;
    const isSender = idOf(msg.sender) === String(viewerId);
    const copy = { ...msg, mediaUrl: null, e2ee: undefined };
    delete copy.e2ee;
    copy.viewOnceState = isSender
        ? (anyOpened ? 'opened' : (msg.viewOnceExpired ? 'expired' : 'sent'))
        : (opened ? 'opened' : (msg.viewOnceExpired ? 'expired' : 'ready'));
    delete copy.viewOnceOpenedBy;
    return copy;
};

/** Short label for chat lists and pushes. */
export const previewLabel = (messageType, { viewOnce = false, gifTitle = '' } = {}) => {
    if (viewOnce) return messageType === 'video' ? '📹 View-once video' : '📷 View-once photo';
    switch (messageType) {
        case 'encrypted': return '🔒 Message';
        case 'gif': return 'GIF';
        case 'sticker': return 'Sticker';
        case 'image': return '📷 Photo';
        case 'video': return '📹 Video';
        case 'audio': return '🎤 Voice message';
        case 'file': return '📎 File';
        default: return gifTitle || '';
    }
};
