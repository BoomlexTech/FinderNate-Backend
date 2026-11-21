/**
 * The public address of this API, for links that leave the server: buttons in
 * emails, unsubscribe links and the like.
 *
 * BACKEND_URL is validated, not trusted. The deployed value has been
 * `https://api.findernate.com` — a host with no DNS record (the API lives on
 * `apis.findernate.com`) — so every "Confirm details" / "Reject" button in the
 * business-details email opened a browser error page (client bug list,
 * 20 Nov 2026). A link that cannot be opened is worse than no link, so a value
 * that is missing, malformed or known to be dead falls back to the address
 * that works. Same approach as EMAIL_HOST in utils/sendEmail.js.
 */
const WORKING_API_URL = 'https://apis.findernate.com';

/** Hosts that have been configured by mistake and do not resolve. */
const DEAD_API_HOSTS = new Set(['api.findernate.com']);

let warned = false;
const warnOnce = (message) => {
    if (warned) return;
    warned = true;
    console.warn(`⚠️  ${message}`);
};

export const publicApiUrl = (configured = process.env.BACKEND_URL) => {
    const raw = String(configured || '').trim().replace(/\/+$/, '');
    if (!raw) return WORKING_API_URL;
    let url;
    try {
        url = new URL(raw);
    } catch {
        warnOnce(`BACKEND_URL="${raw}" is not a web address — using ${WORKING_API_URL} for links in emails and payment confirmations.`);
        return WORKING_API_URL;
    }
    if (!/^https?:$/.test(url.protocol)) {
        warnOnce(`BACKEND_URL="${raw}" is not an http(s) address — using ${WORKING_API_URL} for links in emails and payment confirmations.`);
        return WORKING_API_URL;
    }
    if (DEAD_API_HOSTS.has(url.hostname.toLowerCase())) {
        warnOnce(`BACKEND_URL points at ${url.hostname}, which does not exist — using ${WORKING_API_URL} for links in emails and payment confirmations. Set BACKEND_URL=${WORKING_API_URL}.`);
        return WORKING_API_URL;
    }
    return raw;
};

/** The website's address (business settings, profile links in emails). */
export const publicSiteUrl = (configured = process.env.FRONTEND_URL) => {
    const raw = String(configured || '').trim().replace(/\/+$/, '');
    if (!raw) return 'https://findernate.com';
    try {
        const url = new URL(raw);
        return /^https?:$/.test(url.protocol) ? raw : 'https://findernate.com';
    } catch {
        return 'https://findernate.com';
    }
};
