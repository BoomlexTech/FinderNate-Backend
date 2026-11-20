import crypto from 'crypto';

/**
 * Rules for the "confirm your business details" email (client spec #4).
 *
 * Pure functions only (no database, no environment), so the unit tests can
 * load this file on its own.
 *
 * How a link works
 * ----------------
 * Each button in the email carries the business id, the action, when the
 * email was sent, a short fingerprint of the details it listed, and a
 * signature over all four. The server checks the signature, then compares the
 * fingerprint with the details on record NOW:
 *
 *  - same details  → the link is good, however many emails were sent since;
 *  - other details → the email is out of date (the owner edited something
 *    after it was sent) and is refused with a clear message.
 *
 * It used to compare the email's send time with the LAST email's send time.
 * Saving twice in a row sends two emails, so the buttons of whichever one was
 * not the last answered "Link expired" although nothing had changed.
 *
 * Opening a link never changes anything by itself. It shows a page with the
 * details and one button; pressing that button (a form POST) records the
 * answer. Mail scanners and link previews fetch every link in an email, and a
 * confirmation that locks the details for good must not be something a
 * scanner can trigger.
 */

export const DETAILS_ACTIONS = Object.freeze(['confirm', 'reject']);

/** A link older than this is refused; the owner asks for a fresh email. */
export const DETAILS_LINK_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = stable(value[key]);
            return acc;
        }, {});
    }
    return value ?? null;
};

/** Short fingerprint of the details an email lists. Key order does not matter. */
export const snapshotHash = (snapshot) => crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(snapshot || {})))
    .digest('hex')
    .slice(0, 16);

const sign = (secret, parts) => crypto
    .createHmac('sha256', String(secret))
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 32);

/**
 * Signature for one button. Without `hash` this is the format of emails sent
 * before 20 Nov 2026, which stay valid.
 */
export const signDetailsLink = ({ secret, businessId, action, sentAtMs, hash }) =>
    sign(secret, hash ? [businessId, action, sentAtMs, hash] : [businessId, action, sentAtMs]);

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Reads and checks the parameters of a link (query string or form body).
 * @returns {{ok: true, businessId: string, action: string, sentAtMs: number, hash: string|null, token: string}
 *          | {ok: false, reason: 'malformed' | 'bad_signature'}}
 */
export const readDetailsLink = (params = {}, secret) => {
    const businessId = String(first(params.b) ?? '');
    const action = String(first(params.a) ?? '');
    const sentAtRaw = String(first(params.s) ?? '');
    const hashRaw = first(params.h);
    const token = String(first(params.t) ?? '');
    const hash = hashRaw === undefined || hashRaw === null || hashRaw === '' ? null : String(hashRaw);

    if (!/^[a-f0-9]{24}$/i.test(businessId)) return { ok: false, reason: 'malformed' };
    if (!DETAILS_ACTIONS.includes(action)) return { ok: false, reason: 'malformed' };
    if (!/^\d{10,16}$/.test(sentAtRaw)) return { ok: false, reason: 'malformed' };
    if (hash !== null && !/^[a-f0-9]{16}$/i.test(hash)) return { ok: false, reason: 'malformed' };
    if (!/^[a-f0-9]{32}$/i.test(token)) return { ok: false, reason: 'malformed' };

    const sentAtMs = Number(sentAtRaw);
    const expected = signDetailsLink({ secret, businessId, action, sentAtMs, hash });
    if (!safeEqual(token.toLowerCase(), expected)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, businessId, action, sentAtMs, hash, token };
};

/**
 * What a valid link should do, given the business as it is now.
 *
 * @param {object} link      result of readDetailsLink (ok: true)
 * @param {object} state
 * @param {boolean} state.locked            details already confirmed
 * @param {string}  state.status            none | sent | confirmed | rejected
 * @param {number|null} state.latestSentAtMs when the last email went out
 * @param {number|null} state.respondedAtMs  when the last answer was given
 * @param {string}  state.currentHash       snapshotHash of the details on record
 * @param {number}  [now]
 * @returns {'ask' | 'already_confirmed' | 'confirmed_cannot_reject' | 'already_rejected' | 'outdated' | 'expired'}
 */
export const decideDetailsLink = (link, state = {}, now = Date.now()) => {
    if (now - link.sentAtMs > DETAILS_LINK_MAX_AGE_MS) return 'expired';

    if (state.locked) {
        return link.action === 'confirm' ? 'already_confirmed' : 'confirmed_cannot_reject';
    }

    const matchesRecord = link.hash
        ? link.hash === state.currentHash
        // Older emails carry no fingerprint: only the last one sent can be trusted
        // to show the details on record.
        : state.latestSentAtMs != null && Number(state.latestSentAtMs) === link.sentAtMs;
    if (!matchesRecord) return 'outdated';

    // "Reject" pressed again on an email that was already rejected.
    if (
        link.action === 'reject' &&
        state.status === 'rejected' &&
        state.respondedAtMs != null &&
        Number(state.respondedAtMs) >= link.sentAtMs
    ) return 'already_rejected';

    return 'ask';
};

/** The four query parameters (five with the fingerprint) of one button. */
export const detailsLinkParams = ({ secret, businessId, action, sentAtMs, hash }) => ({
    b: String(businessId),
    a: action,
    s: String(sentAtMs),
    ...(hash ? { h: hash } : {}),
    t: signDetailsLink({ secret, businessId: String(businessId), action, sentAtMs, hash }),
});
