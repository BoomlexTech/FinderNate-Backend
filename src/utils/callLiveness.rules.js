/**
 * Is a call that the database says is "open" really still going on?
 *
 * A call is closed when one side tells the server it ended. When neither side
 * does — the app was killed mid-call, the phone lost its connection, the
 * battery died — the call stayed open for ever, and the "already in a call"
 * check then refused every later call to or from both people without ringing
 * anyone (client bug list, 20 Nov 2026: "when the first call is connected,
 * subsequent call attempts are not triggering call notifications").
 *
 * These rules decide when such a call can be closed. Pure functions only, so
 * the unit tests can load this file on its own.
 */

export const OPEN_CALL_STATUSES = Object.freeze(['initiated', 'ringing', 'connecting', 'active']);

/** A phone rings for 30 s; the rest is for a slow push and a slow tap. */
export const RING_WINDOW_MS = 50 * 1000;

/** After Accept both sides join the media room; this long without anyone in it is not a call. */
export const JOIN_GRACE_MS = 75 * 1000;

/** One person alone in the room of a two-person call, for this long, is not a call either. */
export const ALONE_GRACE_MS = 3 * 60 * 1000;

/** When the media room cannot be asked, only a call this long is taken for abandoned. */
export const UNKNOWN_ROOM_MAX_MS = 3 * 60 * 60 * 1000;

const ms = (date) => (date ? new Date(date).getTime() : NaN);

/**
 * @param {object} call              { status, initiatedAt, startedAt }
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {object} [options.room]    what the media service says about the room:
 *                                   { known: boolean, ended?: boolean, participants?: number }
 * @returns {'live' | 'missed' | 'ended'}
 *   live    leave it alone: someone may really be on this call
 *   missed  rang out and was never answered
 *   ended   was answered, and is over
 */
export const staleCallVerdict = (call, { now = Date.now(), room } = {}) => {
    const status = call?.status;
    if (!OPEN_CALL_STATUSES.includes(status)) return 'live'; // already closed: nothing to decide

    const initiatedAt = ms(call.initiatedAt) || ms(call.createdAt) || 0;

    if (status === 'initiated' || status === 'ringing') {
        return now - initiatedAt > RING_WINDOW_MS ? 'missed' : 'live';
    }

    // connecting / active: it was answered.
    const since = ms(call.startedAt) || initiatedAt;
    const age = now - since;

    if (room?.known) {
        if (room.ended) return 'ended';
        const people = Number(room.participants) || 0;
        if (people === 0) return age > JOIN_GRACE_MS ? 'ended' : 'live';
        if (people === 1) return age > ALONE_GRACE_MS ? 'ended' : 'live';
        return 'live';
    }
    return age > UNKNOWN_ROOM_MAX_MS ? 'ended' : 'live';
};

/**
 * The fields to store when closing a call nobody closed.
 * A missed call has no length. For an answered one the room's own end time is
 * used when it is known; otherwise the call is recorded with no length rather
 * than one that runs until whenever it happened to be noticed.
 */
export const staleCallClosure = (call, verdict, { now = new Date(), roomEndedAt = null } = {}) => {
    if (verdict === 'missed') {
        return { status: 'missed', endedAt: now, endReason: 'timeout' };
    }
    const startedAt = call?.startedAt ? new Date(call.startedAt) : null;
    let endedAt = roomEndedAt ? new Date(roomEndedAt) : null;
    if (!endedAt || Number.isNaN(endedAt.getTime()) || (startedAt && endedAt < startedAt)) {
        endedAt = startedAt || now;
    }
    return { status: 'ended', endedAt, endReason: 'network_error' };
};

/** What the caller is told when the other person really is on another call. */
export const busyMessage = ({ callerBusy, receiverName }) => (callerBusy
    ? 'You are already in a call. End it before starting another one.'
    : `${receiverName || 'This person'} is on another call. Please try again in a little while.`);
