import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/user.models.js';
import { verifyUnsubscribeToken } from '../utils/emailDigest.utils.js';
import { escapeHtml } from '../utils/emailTemplate.js';

/**
 * GET or POST /api/v1/email/unsubscribe?u&c&t — the link in the digest email
 * (Phase 2 #10). POST is the one-click form mail apps use (RFC 8058).
 * Turning a category back on is done in Settings.
 */
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f6;color:#111;margin:0;padding:48px 16px}main{max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#444}a{color:#b45309}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;

export const unsubscribeEmail = asyncHandler(async (req, res) => {
    const u = String(req.query.u || req.body?.u || '');
    const c = String(req.query.c || req.body?.c || '');
    const t = String(req.query.t || req.body?.t || '');
    if (!verifyUnsubscribeToken(u, c, t)) {
        return res.status(400).type('html').send(page('This link is not valid', 'You can change which emails you get in Settings → Notifications in the Findernate app or website.'));
    }
    await User.updateOne({ _id: u }, { $set: { [`emailNotifications.${c}`]: 'off' } });
    const what = c === 'messages' ? 'message emails' : 'activity emails';
    const app = (process.env.FRONTEND_URL || 'https://findernate.com').replace(/\/+$/, '');
    return res.status(200).type('html').send(page('You are unsubscribed', `You won't get ${what} from Findernate any more. To turn them back on, go to <a href="${app}/settings">Settings</a> → Notifications.`));
});
