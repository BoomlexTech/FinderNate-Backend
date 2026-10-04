import { sendEmail } from './sendEmail.js';
import { renderEmail, emailParagraph, emailDetails, emailCallout } from './emailTemplate.js';

/**
 * Email the owner when a human has to act, without making the request that
 * triggered it wait or fail.
 *
 * Goes to ADMIN_ALERT_EMAIL, falling back to SUPPORT_EMAIL (the same pair the
 * guest-refund alert uses). Never throws: with no address set it just reports
 * `success: false`, and sendEmail already returns a result instead of throwing.
 * Callers do not await it on a user-facing path.
 *
 * @param {object} alert
 * @param {string} alert.subject
 * @param {string} alert.title
 * @param {string} [alert.preheader]
 * @param {string} alert.intro
 * @param {string} [alert.quote]  Text shown in a callout, e.g. the user's message
 * @param {Array<[string, string]>} [alert.details]
 * @param {string} [alert.footer]
 */
export const sendAdminAlert = async ({ subject, title, preheader = '', intro, quote, details = [], footer }) => {
    const to = process.env.ADMIN_ALERT_EMAIL || process.env.SUPPORT_EMAIL;
    if (!to) return { success: false, error: 'ADMIN_ALERT_EMAIL and SUPPORT_EMAIL are both unset' };

    try {
        const rows = details.map(([label, value]) => [label, String(value || 'Not provided')]);

        const bodyHtml =
            emailParagraph(intro, { topGap: 0 })
            + (quote ? emailCallout(quote) : '')
            + (rows.length ? emailDetails(rows) : '')
            + (footer ? emailParagraph(footer) : '');

        const textBody = [
            title, '',
            intro, '',
            ...(quote ? [quote, ''] : []),
            ...rows.map(([label, value]) => `${label}: ${value}`),
            ...(rows.length ? [''] : []),
            ...(footer ? [footer] : [])
        ].join('\n');

        return await sendEmail({
            to,
            subject: String(subject).replace(/[\r\n]+/g, ' '),
            html: renderEmail({ title, preheader, bodyHtml }),
            text: textBody
        });
    } catch (err) {
        console.error('[admin-alert] Could not send alert:', err?.message);
        return { success: false, error: err?.message || 'Alert failed' };
    }
};
