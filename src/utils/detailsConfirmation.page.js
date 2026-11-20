import { escapeHtml } from './emailTemplate.js';

/**
 * The small web pages behind the buttons of the "confirm your business
 * details" email. Plain HTML, no scripts, readable on a phone: most owners
 * open the email on the phone they use the app on.
 *
 * Everything shown comes through escapeHtml.
 */

const GOLD = '#FDC700';
const INK = '#1A1A1A';
const MUTED = '#6B7280';
const BORDER = '#E5E7EB';

const TONES = {
    success: { bg: '#ECFDF5', fg: '#047857', mark: '&#10003;' },
    info: { bg: '#FFFBEB', fg: '#8A6414', mark: '&#8505;' },
    warning: { bg: '#FEF2F2', fg: '#B91C1C', mark: '!' },
};

const detailsTable = (rows) => (rows?.length
    ? `<table class="rows">${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table>`
    : '');

const hiddenInputs = (fields) => Object.entries(fields || {})
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');

/**
 * @param {object} page
 * @param {string} page.title
 * @param {string} page.message
 * @param {'success'|'info'|'warning'} [page.tone]
 * @param {Array<[string,string]>} [page.rows]      the business details
 * @param {string} [page.note]                      small print under the details
 * @param {object} [page.form]                      { action, fields, label, kind: 'confirm'|'reject' }
 * @param {object} [page.secondary]                 { href, label } - a plain link button
 * @param {string} [page.settingsUrl]
 */
export const renderDetailsPage = ({ title, message, tone = 'info', rows, note, form, secondary, settingsUrl }) => {
    const t = TONES[tone] || TONES.info;
    const button = form
        ? `<form method="post" action="${escapeHtml(form.action)}">${hiddenInputs(form.fields)}<button type="submit" class="btn ${form.kind === 'reject' ? 'btn-reject' : 'btn-confirm'}">${escapeHtml(form.label)}</button></form>`
        : '';
    const second = secondary
        ? `<a class="btn btn-plain" href="${escapeHtml(secondary.href)}">${escapeHtml(secondary.label)}</a>`
        : '';
    const settings = settingsUrl
        ? `<p class="foot"><a href="${escapeHtml(settingsUrl)}">Open business settings</a> &middot; or go back to the Findernate app</p>`
        : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} - Findernate</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#F5F5F5;color:${INK};font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5}
.wrap{max-width:520px;margin:0 auto;padding:24px 16px 40px}
.card{background:#fff;border:1px solid ${BORDER};border-radius:16px;overflow:hidden}
.brand{background:${GOLD};padding:18px 24px;font-size:20px;font-weight:700;letter-spacing:.2px}
.body{padding:24px}
.mark{width:44px;height:44px;border-radius:50%;background:${t.bg};color:${t.fg};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;margin-bottom:14px}
h1{font-size:20px;line-height:28px;margin:0 0 8px}
p{margin:0 0 12px;font-size:15px}
.rows{width:100%;border-collapse:collapse;margin:16px 0 4px;border:1px solid ${BORDER};border-radius:12px;overflow:hidden}
.rows th,.rows td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:14px}
.rows tr:last-child th,.rows tr:last-child td{border-bottom:0}
.rows th{width:38%;color:${MUTED};font-weight:500;background:#FAFAFA}
.rows td{font-weight:600;word-break:break-word}
.note{color:${MUTED};font-size:13px;margin-top:12px}
.actions{margin-top:20px;display:flex;flex-direction:column;gap:10px}
form{margin:0}
.btn{display:block;width:100%;text-align:center;border:0;border-radius:12px;padding:14px 18px;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none}
.btn-confirm{background:${GOLD};color:${INK}}
.btn-reject{background:#B91C1C;color:#fff}
.btn-plain{background:#fff;color:${INK};border:1px solid ${BORDER}}
.foot{margin:18px 0 0;font-size:13px;color:${MUTED};text-align:center}
.foot a{color:#8A6414}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="brand">FinderNate</div>
    <div class="body">
      <div class="mark" aria-hidden="true">${t.mark}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${detailsTable(rows)}
      ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
      ${button || second ? `<div class="actions">${button}${second}</div>` : ''}
      ${settings}
    </div>
  </div>
</div>
</body>
</html>`;
};
