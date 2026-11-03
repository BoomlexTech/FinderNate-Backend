import nodemailer from 'nodemailer';

/**
 * Send a transactional email.
 *
 * Returns a RESULT rather than throwing. Every caller (password-reset OTP,
 * email-change OTP, notifications, the guest-checkout claim link) sits on a
 * path where a bounced email must not take the whole operation down with it —
 * a failed claim email may not fail a payment that has already settled. But
 * the previous version swallowed the error and returned `undefined`, so those
 * callers reported success unconditionally and a silently dead mailbox was
 * indistinguishable from a delivered message. Check `success`.
 *
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
// Host and port are configurable, with Zoho's SMTP as the default because that
// is what this deployment uses. They were previously hardcoded while .env
// carried EMAIL_HOST and EMAIL_PORT that nothing read — so changing either had
// no effect and cost real debugging time.
//
// Port drives the transport mode and the two must agree: 465 is implicit TLS
// (secure: true), 587 is STARTTLS (secure: false). Deriving `secure` from the
// port rather than taking it as a third setting removes the combination that
// silently fails to connect.
const DEFAULT_SMTP_HOST = 'smtp.zoho.com';

// EMAIL_HOST is validated, not trusted, because the deployed .env currently
// holds `EMAIL_HOST=FindeNate` — a (misspelled) display name someone put in a
// hostname slot. That was harmless while the host was hardcoded, but the moment
// this file started honouring the variable it would have pointed every SMTP
// connection at a name that does not resolve, breaking password resets, OTPs and
// the guest-checkout claim link platform-wide. A value with no dot in it cannot
// be a public mail host, so it is rejected in favour of the working default and
// reported loudly rather than obeyed silently.
const resolveSmtpHost = () => {
    const configured = process.env.EMAIL_HOST?.trim();
    if (!configured) return DEFAULT_SMTP_HOST;

    const looksLikeHostname = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(configured);
    if (!looksLikeHostname) {
        console.warn(
            `⚠️  EMAIL_HOST="${configured}" is not a hostname — ignoring it and using ` +
            `${DEFAULT_SMTP_HOST}. If you meant to set the sender's display name, ` +
            `use EMAIL_FROM_NAME. If you meant the mail server, use something like ` +
            `smtp.zoho.com.`
        );
        return DEFAULT_SMTP_HOST;
    }
    return configured;
};

const SMTP_HOST = resolveSmtpHost();
const SMTP_PORT = Number(process.env.EMAIL_PORT) || 465;

// The address mail is sent AS. Defaults to the authenticating mailbox, but can
// differ when the SMTP account is allowed to send on behalf of another address.
const FROM_ADDRESS = process.env.EMAIL_FROM?.trim() || process.env.EMAIL_USER;
const FROM_NAME = process.env.EMAIL_FROM_NAME?.trim() || 'FinderNate';

// `text` is optional but strongly preferred: an HTML-only message is a spam
// signal at Gmail and Outlook, and this deployment is already fighting a
// filtering problem for an unrelated reason (a From: domain whose SPF/DKIM did
// not align). Passing both parts sends multipart/alternative, which removes one
// more reason to be filtered — and it is also what a screen reader, a watch and
// a plain-text client actually read. Callers that omit it still work exactly as
// before; nodemailer just sends the HTML part alone.
export const sendEmail = async ({ to, subject, html, text, headers }) => {
    // The From: domain must match the product's domain and have SPF + DKIM
    // published for it, or Gmail and Outlook score the message as spoofing and
    // file it as spam — which for the guest-checkout claim link means the buyer
    // never learns how to set their password on the account we made for them.
    // Set EMAIL_USER (and EMAIL_FROM if they differ) to a findernate.com mailbox.
    if (FROM_ADDRESS && !/@findernate\.com$/i.test(FROM_ADDRESS)) {
        console.warn(
            `⚠️  Email is being sent from ${FROM_ADDRESS}, which is not on findernate.com. ` +
            `SPF/DKIM will not align with the "FinderNate" sender name and these ` +
            `messages will be filtered as spam. Point EMAIL_USER/EMAIL_FROM at a ` +
            `findernate.com mailbox.`
        );
    }

    try {
        const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const info = await transporter.sendMail({
            from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
            to,
            subject,
            html,
            // Omitted entirely when the caller did not supply one — passing
            // `text: undefined` is fine, but being explicit keeps the sent
            // message identical to before for the callers not yet templated.
            ...(text ? { text } : {}),
            // e.g. List-Unsubscribe for the daily digest (Phase 2 #10).
            ...(headers ? { headers } : {}),
        });

        return { success: true, messageId: info?.messageId };
    } catch (error) {
        // Still not thrown — but no longer invisible. Logged with the recipient
        // and subject so a delivery failure can actually be traced, and handed
        // back to the caller so it can decide what to do about it.
        console.error(`❌ Email send failed (to=${to}, subject="${subject}"):`, error);
        return { success: false, error: error?.message || 'Email send failed' };
    }
};
