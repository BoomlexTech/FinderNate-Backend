import cron from 'node-cron';
import Notification from '../models/notification.models.js';
import { User } from '../models/user.models.js';
import notificationCache from '../utils/notificationCache.utils.js';
import { sendEmail } from '../utils/sendEmail.js';
import { renderEmail, emailParagraph, emailButton, escapeHtml } from '../utils/emailTemplate.js';
import { DIGEST_TYPES, digestLines, unsubscribeUrl } from '../utils/emailDigest.utils.js';

/**
 * Daily digest email (Phase 2 #10), 09:10 IST.
 *
 * Goes to people with unread activity from the last 24 hours who haven't
 * turned the digest off. Each account is claimed atomically
 * (emailDigestSentAt), so several API servers running this job send one
 * email per person per day. Capped per run (EMAIL_DIGEST_MAX_PER_RUN,
 * default 1000) to stay inside the mail provider's daily limit.
 */
const DAY = 24 * 60 * 60 * 1000;
const appUrl = () => (process.env.FRONTEND_URL || 'https://findernate.com').replace(/\/+$/, '');

export const runEmailDigest = async () => {
    const maxPerRun = Number(process.env.EMAIL_DIGEST_MAX_PER_RUN) || 1000;
    const since = new Date(Date.now() - DAY);
    const groups = await Notification.aggregate([
        { $match: { createdAt: { $gte: since }, isRead: false, type: { $in: DIGEST_TYPES } } },
        { $group: { _id: { r: '$receiverId', t: '$type' }, n: { $sum: 1 } } },
        { $group: { _id: '$_id.r', counts: { $push: { k: '$_id.t', v: '$n' } }, total: { $sum: '$n' } } },
        { $sort: { total: -1 } },
        { $limit: maxPerRun },
    ]);

    let sent = 0;
    for (const g of groups) {
        const user = await User.findOne({
            _id: g._id,
            isDeleted: { $ne: true },
            accountStatus: 'active',
            'emailNotifications.activity': { $ne: 'off' },
        }).select('email fullName username emailNotifications').lean();
        if (!user?.email) continue;

        const claimed = await User.updateOne(
            { _id: user._id, $or: [{ emailDigestSentAt: null }, { emailDigestSentAt: { $lte: new Date(Date.now() - 20 * 60 * 60 * 1000) } }] },
            { $set: { emailDigestSentAt: new Date() } },
        );
        if (!claimed.modifiedCount) continue;

        let unreadMessages = 0;
        if (user.emailNotifications?.messages !== 'off') {
            try { unreadMessages = (await notificationCache.getUnreadCounts(user._id))?.unreadMessages || 0; } catch { /* skip the line */ }
        }
        const counts = Object.fromEntries(g.counts.map((c) => [c.k, c.v]));
        const lines = digestLines(counts, unreadMessages);
        if (!lines.length) continue;

        const name = user.fullName || user.username || 'there';
        const offActivity = unsubscribeUrl(user._id, 'activity');
        const offMessages = unsubscribeUrl(user._id, 'messages');
        const subject = `You have ${lines[0]} on Findernate`;
        const bodyHtml = emailParagraph(`Hi ${name},`, { topGap: 0 })
            + emailParagraph('Here is what happened while you were away:')
            + lines.map((l) => emailParagraph(`• ${l}`, { topGap: 6 })).join('')
            + emailButton({ label: 'Open Findernate', url: `${appUrl()}/notifications` })
            + emailParagraph('You get this email at most once a day. Change it in Settings → Notifications, or stop activity emails or message emails.', { muted: true });
        const text = [
            `Hi ${name},`, '', 'Here is what happened while you were away:', ...lines.map((l) => `- ${l}`), '',
            `Open Findernate: ${appUrl()}/notifications`, '',
            `Stop activity emails: ${offActivity}`, `Stop message emails: ${offMessages}`,
        ].join('\n');
        const html = renderEmail({ title: 'Your day on Findernate', preheader: lines.join(' · '), bodyHtml })
            .replace('stop activity emails', `<a href="${escapeHtml(offActivity)}">stop activity emails</a>`)
            .replace('message emails.', `<a href="${escapeHtml(offMessages)}">message emails</a>.`);

        const result = await sendEmail({
            to: user.email,
            subject,
            html,
            text,
            headers: {
                'List-Unsubscribe': `<${offActivity}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
        });
        if (result?.success) sent += 1;
        else await User.updateOne({ _id: user._id }, { $set: { emailDigestSentAt: null } });
    }
    if (sent) console.log(`📧 [Digest] sent ${sent} daily digest email(s)`);
    return sent;
};

export const startEmailDigestJob = () => {
    if (process.env.EMAIL_DIGEST_ENABLED === 'false') return;
    cron.schedule('10 9 * * *', () => {
        runEmailDigest().catch((err) => console.error('[Digest] run failed:', err?.message));
    }, { timezone: 'Asia/Kolkata' });
};

