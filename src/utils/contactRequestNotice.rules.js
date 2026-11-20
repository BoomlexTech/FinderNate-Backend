/**
 * Contact-info requests in the notification list (client bug list, 20 Nov
 * 2026: "the notification appears, but there are no options to Accept or
 * Reject").
 *
 * The notification was stored as a bare sentence, with nothing saying which
 * request it belonged to, so no client could offer the two buttons. New
 * notifications carry `data.kind` and the request id; the list endpoint adds
 * the request's CURRENT status to each one (`contactRequest`), so the buttons
 * disappear once it is answered — on every device, and for notifications
 * stored before this change too.
 *
 * Pure functions only, so the unit tests can load this file on its own.
 */

export const CONTACT_REQUEST_KIND = 'contact_request';
export const CONTACT_RESPONSE_KIND = 'contact_request_response';

/** What createContactRequestNotification stores in `data`. */
export const contactRequestData = ({ requestId, businessId }) => ({
    kind: CONTACT_REQUEST_KIND,
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...(businessId ? { businessId: String(businessId) } : {}),
});

/** What createContactResponseNotification stores in `data`. */
export const contactResponseData = ({ requestId, businessId, status }) => ({
    kind: CONTACT_RESPONSE_KIND,
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...(businessId ? { businessId: String(businessId) } : {}),
    ...(status ? { status: String(status) } : {}),
});

const REQUEST_TEXT = /^requested (your )?contact details\b/i;
const RESPONSE_TEXT = /^(shared contact details for|declined your contact request for)\b/i;

/**
 * 'request' (someone asked the receiver for contact details), 'response' (the
 * business answered the receiver's request) or null. Notifications stored
 * before `data.kind` existed are recognised by their sentence.
 */
export const contactNoticeKind = (notification) => {
    const kind = notification?.data?.kind;
    if (kind === CONTACT_REQUEST_KIND) return 'request';
    if (kind === CONTACT_RESPONSE_KIND) return 'response';
    if (notification?.type !== 'others') return null;
    const message = String(notification?.message || '').trim();
    if (REQUEST_TEXT.test(message)) return 'request';
    if (RESPONSE_TEXT.test(message)) return 'response';
    return null;
};

const idOf = (value) => {
    if (!value) return '';
    if (typeof value === 'object' && value._id) return String(value._id);
    return String(value);
};

/**
 * How to find the request behind one notification:
 *  - by id when the notification carries it,
 *  - else by the two people involved (a requester has one request per business).
 * Returns null when the notification is not about a contact request, or when
 * there is not enough to look anything up.
 */
export const contactRequestLookup = (notification) => {
    const kind = contactNoticeKind(notification);
    if (!kind) return null;
    const requestId = notification?.data?.requestId;
    if (requestId && /^[a-f0-9]{24}$/i.test(String(requestId))) return { kind, by: 'id', requestId: String(requestId) };
    const sender = idOf(notification?.senderId);
    const receiver = idOf(notification?.receiverId);
    if (!sender || !receiver) return null;
    return kind === 'request'
        ? { kind, by: 'people', requester: sender, businessOwner: receiver }
        : { kind, by: 'people', requester: receiver, businessOwner: sender };
};

/**
 * Picks, from the requests found for a page of notifications, the one that
 * belongs to `lookup`. When two people have requests for several businesses of
 * one owner (legacy notifications, no id), the one made closest before the
 * notification wins.
 */
export const matchContactRequest = (lookup, requests = [], notifiedAt = null) => {
    if (!lookup) return null;
    if (lookup.by === 'id') return requests.find((r) => idOf(r._id) === lookup.requestId) || null;
    const candidates = requests.filter((r) => idOf(r.requester) === lookup.requester && idOf(r.businessOwner) === lookup.businessOwner);
    if (candidates.length <= 1) return candidates[0] || null;
    const at = notifiedAt ? new Date(notifiedAt).getTime() : NaN;
    if (!Number.isFinite(at)) return candidates[0];
    const stamp = (r) => new Date((lookup.kind === 'request' ? r.createdAt : r.respondedAt) || r.createdAt || 0).getTime();
    return [...candidates].sort((a, b) => Math.abs(stamp(a) - at) - Math.abs(stamp(b) - at))[0];
};

/** The block added to a notification for the clients. */
export const contactRequestView = (kind, request) => {
    if (!request) return null;
    return {
        kind,
        requestId: idOf(request._id),
        businessId: idOf(request.business),
        status: request.status || 'pending',
        message: request.message || '',
        responseMessage: request.responseMessage || '',
        // The receiver of a 'request' notification is the owner, who may answer
        // while it is still pending.
        canRespond: kind === 'request' && (request.status || 'pending') === 'pending',
    };
};
