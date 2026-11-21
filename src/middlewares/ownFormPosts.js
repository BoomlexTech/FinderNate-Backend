/**
 * Lets the pages this server renders itself post their own forms back.
 *
 * The business-details email opens a page on this server with "Confirm
 * details" / "Something is wrong" buttons: a plain HTML form that posts back
 * to the same address. Helmet sends every page with
 * `Referrer-Policy: no-referrer`, and under that policy a browser sends a form
 * post, even one to the same site, with `Origin: null`. The CORS allow-list
 * refused "null" with an error, so pressing the button showed a 500 and
 * nothing was saved (client bug list, 20 Nov 2026, item 1; seen in the live
 * logs on 21 Nov).
 *
 * These endpoints are public and authorised by the signed token in the form,
 * not by a cookie, so where a top-level form post comes from does not matter
 * there. For them alone a "null" origin is treated like a request without
 * one. Every other route keeps the allow-list exactly as it is.
 */
export const OWN_FORM_POSTS = new Set([
    '/api/v1/kyc/business/confirm-details',
    '/api/v1/email/unsubscribe',
]);

export const allowOwnFormPosts = (req, _res, next) => {
    const path = String(req.path || '').replace(/\/+$/, '');
    if (req.method === 'POST' && req.headers.origin === 'null' && OWN_FORM_POSTS.has(path)) {
        delete req.headers.origin;
    }
    next();
};
