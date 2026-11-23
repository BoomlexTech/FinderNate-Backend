import crypto from 'crypto';
import mongoose from 'mongoose';
import Business from '../models/business.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendEmail } from '../utils/sendEmail.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { refreshStoredTier, tiersFor } from '../utils/businessVisibility.utils.js';
import { maskBusinessIdsForAdmin } from '../utils/businessPrivacy.utils.js';
import {
    decideKyc, effectiveKycStatus, isValidGstin, isValidPan, maskId, normalizeId, panFromGstin,
    visibilityTier, LOCKED_FIELDS, kycCheck,
} from '../utils/phase4.rules.js';
import {
    verificationConfigured, verifyGstin, verifyPan, sendAadhaarOtp, verifyAadhaarOtp,
} from '../services/cashfreeVerify.service.js';
import { publicApiUrl, publicSiteUrl } from '../utils/publicUrls.js';
import { renderEmail, escapeHtml as escapeEmailHtml } from '../utils/emailTemplate.js';
import { renderDetailsPage } from '../utils/detailsConfirmation.page.js';
import {
    snapshotHash, readDetailsLink, decideDetailsLink, detailsLinkParams, signDetailsLink,
} from '../utils/detailsConfirmation.rules.js';

/**
 * Business KYC (Phase 4 #79, #30, #4, #74). See docs/PHASE4_API.md.
 */

const loadBusiness = async (userId) => {
    const business = await Business.findOne({ userId });
    if (!business) throw new ApiError(404, 'Create your business profile first');
    return business;
};

/** The Aadhaar check on record, as a plain object (undefined when there is none). */
const storedAadhaarCheck = (business) => {
    const plain = typeof business?.toObject === 'function' ? business.toObject() : business;
    const check = plain?.kyc?.checks?.aadhaar;
    return check && Object.keys(check).length ? check : undefined;
};

const badgeOf = (b) => (effectiveKycStatus(b) === 'verified'
    ? (b.registrationType === 'unregistered' ? 'verified_seller' : 'registered_business')
    : null);

const publicKyc = (b) => {
    const status = effectiveKycStatus(b);
    return {
        status,
        source: b.kyc?.source || (b.verificationStatus === 'approved' ? 'legacy_admin' : null),
        registrationType: b.registrationType || null,
        gstin: b.gstNumber ? maskId(b.gstNumber, 4) : null,
        pan: b.panNumber ? maskId(b.panNumber, 4) : null,
        aadhaarLast4: b.kyc?.checks?.aadhaar?.last4 || null,
        reasons: b.kyc?.reasons || [],
        badge: badgeOf(b),
        visibility: visibilityTier({ kycStatus: status, plan: b.plan, subscriptionStatus: b.subscriptionStatus }),
        recheckDueAt: b.kyc?.recheckDueAt || null,
        detailsLocked: !!b.detailsLocked,
        detailsConfirmation: b.detailsConfirmation?.status || 'none',
        lockedFields: b.detailsLocked ? LOCKED_FIELDS : [],
        autoCheckAvailable: verificationConfigured(),
    };
};

/** GET /kyc/business */
export const getBusinessKyc = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const data = publicKyc(business);
    data.reKycFee = Number(await getSettingValue('RE_KYC_FEE', 100)) || null;
    return res.status(200).json(new ApiResponse(200, data, 'OK'));
});

const notifyKyc = (userId, status, reasons = []) => notifyActivity({
    recipientId: userId,
    type: 'kyc',
    message: status === 'verified'
        ? 'Your business is verified. Your product, service and business posts can now be seen by your followers, and by everyone with an active plan.'
        : status === 'needs_review'
            ? "We're checking your business details. This usually takes a working day."
            : `Your business verification needs attention: ${reasons.join('; ')}`,
    data: { status },
});

/**
 * POST /kyc/business  { registrationType, gstin?, pan, aadhaarRefId? }
 *
 * Registered: GSTIN + PAN, checked with Cashfree; names must match the
 * business name. Unregistered: PAN + an Aadhaar OTP check done first with
 * /kyc/business/aadhaar/*. A clean pass verifies at once; anything else (or
 * no verification service) goes to the admin queue.
 */
export const submitBusinessKyc = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const { registrationType } = req.body || {};
    if (!['registered', 'unregistered'].includes(registrationType)) throw new ApiError(400, 'Choose registered or unregistered business');
    if (business.detailsLocked && effectiveKycStatus(business) === 'verified') {
        throw new ApiError(409, 'Your verified details are locked. Pay for re-verification to change them.');
    }

    const pan = normalizeId(req.body.pan);
    if (!isValidPan(pan)) throw new ApiError(400, 'Enter a valid PAN, like ABCDE1234F');
    let gstin = null;
    if (registrationType === 'registered') {
        gstin = normalizeId(req.body.gstin);
        if (!isValidGstin(gstin)) throw new ApiError(400, 'Enter a valid 15-character GSTIN');
        if (panFromGstin(gstin) !== pan) throw new ApiError(400, 'This PAN is not the one inside the GSTIN');
    }
    if (registrationType === 'unregistered' && business.kyc?.checks?.aadhaar?.valid !== true && verificationConfigured()) {
        throw new ApiError(400, 'Verify your Aadhaar with the OTP first');
    }

    business.registrationType = registrationType;
    business.panNumber = pan;
    if (gstin) business.gstNumber = gstin;
    business.set('kyc.submittedAt', new Date());

    let gst = null;
    let panRes = null;
    if (verificationConfigured()) {
        try {
            if (gstin) gst = await verifyGstin(gstin, business.businessName);
            panRes = await verifyPan(pan, gst?.legalName || business.businessName);
        } catch (error) {
            console.warn('[kyc] verification service error:', error?.message);
        }
    }
    const now = new Date();
    // Each check is written to its own path. Rebuilding `kyc.checks` from a
    // spread of the document's own value does not work: a nested path of a
    // Mongoose document spreads into `undefined` for the checks that were not
    // touched, and saving then failed with "Cast to Object failed for value
    // undefined at path kyc.checks.aadhaar" — every KYC submission ended in an
    // error (client bug list, 20 Nov 2026).
    if (gst?.available) business.set('kyc.checks.gst', kycCheck(gst, now));
    if (panRes?.available) business.set('kyc.checks.pan', kycCheck(panRes, now));

    let decision;
    if (!verificationConfigured() || (gstin && !gst?.available) || !panRes?.available) {
        decision = { status: 'needs_review', reasons: ['Automatic checks are not available; an admin will review your details'] };
    } else {
        decision = decideKyc({
            registrationType, gst, pan: panRes, aadhaar: storedAadhaarCheck(business), businessName: business.businessName,
        });
    }
    business.set('kyc.status', decision.status);
    business.set('kyc.reasons', decision.reasons);
    if (decision.status === 'verified') {
        business.set('kyc.source', 'auto');
        business.set('kyc.verifiedAt', now);
        business.set('kyc.recheckDueAt', undefined);
        business.verificationStatus = 'approved';
        business.isVerified = true;
    }
    // Only what this request changed is validated: an older business row may
    // hold a value today's schema no longer accepts (an empty bank account
    // type, a retired plan name), and that must not turn a finished check —
    // with the Aadhaar OTP already used up — into an error.
    await business.save({ validateModifiedOnly: true });
    console.log(`[kyc] business ${business._id} submitted (${registrationType}): ${decision.status}${decision.reasons.length ? ` - ${decision.reasons.join('; ')}` : ''}`);
    // The result is saved. Nothing after this may turn the answer into an error.
    await refreshStoredTier(req.user._id).catch((error) => console.warn('[kyc] visibility refresh failed:', error?.message));
    await notifyKyc(req.user._id, decision.status, decision.reasons).catch((error) => console.warn('[kyc] notification failed:', error?.message));
    if (decision.status === 'verified') await maybeSendDetailsConfirmation(business).catch(() => {});

    return res.status(200).json(new ApiResponse(200, publicKyc(business), decision.status === 'verified' ? 'Your business is verified' : 'Submitted for review'));
});

/** POST /kyc/business/aadhaar/otp  { aadhaar } (unregistered businesses) */
export const businessAadhaarOtp = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const r = await sendAadhaarOtp(req.body?.aadhaar);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.ok) {
        console.warn(`[kyc] business ${business._id}: Aadhaar OTP not sent - ${r.message || 'no reason given'}`);
        throw new ApiError(400, r.message || "Couldn't send the OTP");
    }
    console.log(`[kyc] business ${business._id}: Aadhaar OTP sent`);
    return res.status(200).json(new ApiResponse(200, { refId: r.refId, last4: r.last4 }, 'OTP sent to the mobile linked to your Aadhaar'));
});

/** POST /kyc/business/aadhaar/verify  { refId, otp, last4 } */
export const businessAadhaarVerify = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const r = await verifyAadhaarOtp(req.body?.refId, req.body?.otp);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.valid) {
        console.warn(`[kyc] business ${business._id}: Aadhaar OTP not accepted - ${r.message || 'no reason given'}`);
        throw new ApiError(400, r.message || 'The OTP is not correct');
    }
    // Written to its own path with a plain update: the OTP has just been used
    // up at UIDAI, so nothing else about the business document (an old row
    // that fails today's validators, the other checks) may stop the result
    // from being kept. See the note in submitBusinessKyc on why the checks are
    // never rebuilt from a spread.
    await Business.updateOne({ _id: business._id }, {
        $set: {
            'kyc.checks.aadhaar': kycCheck({
                valid: true,
                name: r.name,
                last4: String(req.body?.last4 || '').replace(/\D/g, '').slice(-4),
                refId: r.refId,
            }),
        },
    });
    console.log(`[kyc] business ${business._id}: Aadhaar OTP verified`);
    return res.status(200).json(new ApiResponse(200, { valid: true, name: r.name }, 'Aadhaar verified'));
});

// ─── Regular users' Aadhaar (#80 listings) ──────────────────────────────────

/** POST /kyc/me/aadhaar/otp  { aadhaar } */
// Each step is logged with its outcome (never the number or the OTP), the same
// as the business check: when a seller says "it failed after the OTP", the
// server log shows which step and why.
export const userAadhaarOtp = asyncHandler(async (req, res) => {
    const r = await sendAadhaarOtp(req.body?.aadhaar);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.ok) {
        console.warn(`[kyc] user ${req.user._id}: Aadhaar OTP not sent - ${r.message || 'no reason given'}`);
        throw new ApiError(400, r.message || "Couldn't send the OTP");
    }
    console.log(`[kyc] user ${req.user._id}: Aadhaar OTP sent`);
    return res.status(200).json(new ApiResponse(200, { refId: r.refId, last4: r.last4 }, 'OTP sent'));
});

/** POST /kyc/me/aadhaar/verify  { refId, otp, last4 } */
export const userAadhaarVerify = asyncHandler(async (req, res) => {
    const r = await verifyAadhaarOtp(req.body?.refId, req.body?.otp);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.valid) {
        console.warn(`[kyc] user ${req.user._id}: Aadhaar OTP not accepted - ${r.message || 'no reason given'}`);
        throw new ApiError(400, r.message || 'The OTP is not correct');
    }
    await User.updateOne({ _id: req.user._id }, {
        $set: {
            aadhaarVerification: {
                status: 'verified',
                name: r.name,
                last4: String(req.body?.last4 || '').replace(/\D/g, '').slice(-4),
                refId: r.refId,
                verifiedAt: new Date(),
            },
        },
    });
    console.log(`[kyc] user ${req.user._id}: Aadhaar OTP verified`);
    return res.status(200).json(new ApiResponse(200, { verified: true }, 'Aadhaar verified'));
});

/** GET /kyc/me — the signed-in user's own check status. */
export const getMyKyc = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('aadhaarVerification isBusinessProfile').lean();
    return res.status(200).json(new ApiResponse(200, {
        aadhaarVerified: user?.aadhaarVerification?.status === 'verified',
        aadhaarLast4: user?.aadhaarVerification?.last4 || null,
        autoCheckAvailable: verificationConfigured(),
    }, 'OK'));
});

// ─── Details confirmation email, then locked (#4) ───────────────────────────

const signingSecret = () => process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.ACCESS_TOKEN_SECRET || 'findernate';

/** Signature of an email button in the format used before 20 Nov 2026. Those emails stay valid. */
export const detailsToken = (businessId, action, sentAt) => signDetailsLink({
    secret: signingSecret(),
    businessId: String(businessId),
    action,
    sentAtMs: new Date(sentAt).getTime(),
});

/**
 * The mandatory business details the owner is asked to confirm by email
 * (client spec #4). Sent as soon as the business details are submitted —
 * it used to wait for KYC to be verified, so most people never got it.
 */
const snapshotOf = (b) => ({
    businessName: b.businessName || null,
    businessType: b.businessType || null,
    category: b.category || null,
    description: b.description ? String(b.description).slice(0, 300) : null,
    phone: b.contact?.phone || null,
    email: b.contact?.email || null,
    registrationType: b.registrationType || null,
    gstNumber: b.gstNumber || null,
    panNumber: b.panNumber ? maskId(b.panNumber, 4) : null,
    aadhaar: b.aadhaarNumber ? maskId(String(b.aadhaarNumber), 4) : null,
    address: [b.location?.address, b.location?.city, b.location?.state, b.location?.postalCode].filter(Boolean).join(', ') || null,
});

const sameSnapshot = (a, b) => snapshotHash(a) === snapshotHash(b);

/** Label and value of every detail that has a value, in the order shown to the owner. */
const snapshotRows = (snap) => [
    ['Business name', snap.businessName], ['Business type', snap.businessType], ['Category', snap.category],
    ['Description', snap.description], ['Phone', snap.phone], ['Email', snap.email], ['Address', snap.address],
    ['Registration', snap.registrationType ? (snap.registrationType === 'registered' ? 'Registered (GST)' : 'Unregistered') : null],
    ['GSTIN', snap.gstNumber], ['PAN', snap.panNumber], ['Aadhaar', snap.aadhaar],
].filter(([, v]) => v);

const CONFIRM_PATH = '/api/v1/kyc/business/confirm-details';

/** The address behind one email button. Built on the address that really serves this API. */
const detailsLink = (businessId, action, sentAtMs, hash) => {
    const params = detailsLinkParams({ secret: signingSecret(), businessId: String(businessId), action, sentAtMs, hash });
    return `${publicApiUrl()}${CONFIRM_PATH}?${new URLSearchParams(params)}`;
};

/** Where the confirmation email goes: the business email, else the account email. */
export const confirmationRecipient = async (business) => {
    if (business.contact?.email) return business.contact.email;
    const user = await User.findById(business.userId).select('email').lean();
    return user?.email || null;
};

export const maskEmail = (email) => {
    const [name, domain] = String(email || '').split('@');
    if (!domain) return null;
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
};

const EMAIL_FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One full-width button. A table cell, so Outlook keeps the padding (see emailTemplate.js). */
const emailLinkButton = (url, label, { primary }) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:${primary ? 24 : 10}px 0 0 0;">
              <tr>
                <td align="center" bgcolor="${primary ? '#FDC700' : '#FFFFFF'}" style="background-color:${primary ? '#FDC700' : '#FFFFFF'}; border:1px solid ${primary ? '#FDC700' : '#D1D5DB'}; border-radius:8px;">
                  <a href="${escapeEmailHtml(url)}" style="display:block; padding:13px 20px; font-family:${EMAIL_FONT}; font-size:15px; font-weight:600; line-height:20px; color:#1A1A1A; text-decoration:none;">${escapeEmailHtml(label)}</a>
                </td>
              </tr>
            </table>`;

const emailDetailRows = (rows) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 0 0; border:1px solid #E0E0E0; border-radius:10px;">
              ${rows.map(([label, value], i) => `<tr>
                <td valign="top" width="36%" style="padding:11px 14px; ${i ? 'border-top:1px solid #EEEEEE; ' : ''}font-family:${EMAIL_FONT}; font-size:13px; line-height:19px; color:#6B7280;">${escapeEmailHtml(label)}</td>
                <td valign="top" style="padding:11px 14px; ${i ? 'border-top:1px solid #EEEEEE; ' : ''}font-family:${EMAIL_FONT}; font-size:14px; line-height:19px; font-weight:600; color:#1A1A1A;">${escapeEmailHtml(value)}</td>
              </tr>`).join('\n              ')}
            </table>`;

/** @returns {Promise<{sent: boolean, to?: string, reason?: string}>} */
export const sendDetailsConfirmation = async (business) => {
    const user = await User.findById(business.userId).select('email fullName').lean();
    const to = business.contact?.email || user?.email;
    if (!to) return { sent: false, reason: 'no_email' };

    const sentAt = new Date();
    const snap = snapshotOf(business);
    const hash = snapshotHash(snap);
    const confirmUrl = detailsLink(business._id, 'confirm', sentAt.getTime(), hash);
    const rejectUrl = detailsLink(business._id, 'reject', sentAt.getTime(), hash);
    const rows = snapshotRows(snap);
    const name = String(user?.fullName || '').trim();

    const p = (text, { muted = false, top = 16 } = {}) =>
        `<p style="margin:${top}px 0 0 0; font-family:${EMAIL_FONT}; font-size:${muted ? 13 : 15}px; line-height:${muted ? 20 : 23}px; color:${muted ? '#6B7280' : '#1A1A1A'};">${escapeEmailHtml(text)}</p>`;
    const bodyHtml = [
        p(name ? `Hi ${name},` : 'Hi,', { top: 0 }),
        p('You submitted these business details on Findernate. Please check them and tell us whether they are right.'),
        emailDetailRows(rows),
        emailLinkButton(confirmUrl, 'Confirm details', { primary: true }),
        emailLinkButton(rejectUrl, 'Something is wrong', { primary: false }),
        p('Each button opens a page where you can check the details once more before anything is saved.', { muted: true }),
        p('Once you confirm, these details can no longer be edited. To change them later you will need to request re-verification.', { muted: true, top: 8 }),
    ].join('\n');
    const html = renderEmail({
        title: 'Please confirm your business details',
        preheader: 'Check the business details you submitted on Findernate and confirm them.',
        bodyHtml,
    });
    const text = [
        name ? `Hi ${name},` : 'Hi,',
        '',
        'You submitted these business details on Findernate:',
        ...rows.map(([k, v]) => `${k}: ${v}`),
        '',
        `Confirm details: ${confirmUrl}`,
        `Something is wrong: ${rejectUrl}`,
        '',
        'Once you confirm, these details can no longer be edited. To change them later you will need to request re-verification.',
    ].join('\n');

    const result = await sendEmail({ to, subject: 'Please confirm your business details on Findernate', html, text });
    if (result && result.success === false) {
        console.warn('[kyc] details confirmation email failed:', result.error);
        return { sent: false, to, reason: 'send_failed' };
    }
    const record = { status: 'sent', sentAt, snapshot: snap };
    business.detailsConfirmation = record;
    await Business.updateOne({ _id: business._id }, { $set: { detailsConfirmation: record } });
    return { sent: true, to };
};

/**
 * Sends the confirmation email unless the details are already confirmed
 * (locked) or the same details were already sent and are still waiting for
 * an answer. Called after the business details are created or edited.
 */
export const maybeSendDetailsConfirmation = async (business) => {
    if (!business || business.detailsLocked) return { sent: false, reason: 'locked' };
    if (detailsAlreadyEmailed(business)) return { sent: false, reason: 'already_sent' };
    return sendDetailsConfirmation(business);
};

/**
 * True when the last confirmation email holds exactly the current details and
 * is still waiting for an answer, so saving again sends nothing (for example
 * after changing only the website, which the email does not list).
 */
export const detailsAlreadyEmailed = (business) => {
    const prev = business?.detailsConfirmation;
    return prev?.status === 'sent' && sameSnapshot(prev.snapshot, snapshotOf(business));
};

/** POST /kyc/business/send-confirmation — (re)send the email. */
export const resendDetailsConfirmation = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    if (business.detailsLocked) throw new ApiError(409, 'Your details are already confirmed and can no longer be edited');
    const r = await sendDetailsConfirmation(business);
    if (!r.sent && r.reason === 'no_email') throw new ApiError(400, 'Add a business email first');
    if (!r.sent) throw new ApiError(502, "We couldn't send the email right now. Please try again in a few minutes.");
    return res.status(200).json(new ApiResponse(200, { sent: true, to: maskEmail(r.to) }, `We emailed your details to ${maskEmail(r.to)}`));
});

/** GET /kyc/business/details-confirmation — status for the business settings banner. */
export const getDetailsConfirmation = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const to = await confirmationRecipient(business);
    const status = business.detailsConfirmation?.status || 'none';
    return res.status(200).json(new ApiResponse(200, {
        status,
        sentAt: business.detailsConfirmation?.sentAt || null,
        respondedAt: business.detailsConfirmation?.respondedAt || null,
        locked: !!business.detailsLocked,
        lockedFields: business.detailsLocked ? LOCKED_FIELDS : [],
        to: maskEmail(to),
        message: business.detailsLocked
            ? 'Your business details are confirmed. This information can no longer be edited.'
            : status === 'sent'
                ? `We emailed your details to ${maskEmail(to)}. Open the email to confirm or reject them.`
                : status === 'rejected'
                    ? 'You said some details are wrong. Correct them and save; we will email you again.'
                    : null,
    }, 'OK'));
});

// ── The pages behind the email buttons ──────────────────────────────────────

const sendDetailsPage = (res, page, status = 200) => res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(renderDetailsPage({ settingsUrl: `${publicSiteUrl()}/settings/business`, ...page }));

const msOrNull = (date) => (date ? new Date(date).getTime() : null);

const linkStateOf = (business) => ({
    locked: !!business.detailsLocked,
    status: business.detailsConfirmation?.status || 'none',
    latestSentAtMs: msOrNull(business.detailsConfirmation?.sentAt),
    respondedAtMs: msOrNull(business.detailsConfirmation?.respondedAt),
    currentHash: snapshotHash(snapshotOf(business)),
});

const CONFIRMED_PAGE = {
    title: 'Details confirmed',
    tone: 'success',
    message: 'Thank you. Your business details are confirmed and can no longer be edited. To change them later, request re-verification in business settings.',
};

/**
 * Checks the link and loads the business. Sends the right page itself when
 * the link cannot be used and returns null.
 */
const resolveDetailsLink = async (params, res) => {
    const link = readDetailsLink(params, signingSecret());
    if (!link.ok) {
        sendDetailsPage(res, {
            title: 'This link is not valid',
            tone: 'warning',
            message: 'The link is incomplete or was changed on the way. Open the email again and tap the button, or ask for a new email with "Resend email" in business settings.',
        });
        return null;
    }
    const business = await Business.findById(link.businessId);
    if (!business) {
        sendDetailsPage(res, {
            title: 'Business not found',
            tone: 'warning',
            message: 'This business profile no longer exists, so there is nothing to confirm.',
        });
        return null;
    }
    const outcome = decideDetailsLink(link, linkStateOf(business));
    if (outcome === 'ask') return { link, business };

    if (outcome === 'already_confirmed') {
        sendDetailsPage(res, { ...CONFIRMED_PAGE, rows: snapshotRows(snapshotOf(business)) });
    } else if (outcome === 'confirmed_cannot_reject') {
        sendDetailsPage(res, {
            title: 'These details are already confirmed',
            tone: 'info',
            message: 'You confirmed these details earlier, so they can no longer be edited. To change them, request re-verification in business settings.',
        });
    } else if (outcome === 'already_rejected') {
        sendDetailsPage(res, {
            title: 'Thanks, we have noted it',
            tone: 'info',
            message: 'You already told us these details are wrong. Correct them in business settings and save; we will email you the new details to confirm.',
        });
    } else if (outcome === 'expired') {
        sendDetailsPage(res, {
            title: 'This email is too old',
            tone: 'warning',
            message: 'This link is more than 60 days old. Open business settings (or the Findernate app) and tap "Resend email" to get a new one.',
        });
    } else {
        const to = maskEmail(await confirmationRecipient(business).catch(() => null));
        sendDetailsPage(res, {
            title: 'This email is out of date',
            tone: 'warning',
            message: `Your business details were changed after this email was sent. Please use the most recent email${to ? ` we sent to ${to}` : ''}, or tap "Resend email" in business settings.`,
        });
    }
    return null;
};

const detailsPageFailed = (res, error) => {
    console.error('[kyc] details confirmation page failed:', error?.message || error);
    if (res.headersSent) return;
    sendDetailsPage(res, {
        title: 'Something went wrong',
        tone: 'warning',
        message: 'We could not load this page right now. Please try again in a minute.',
    }, 500);
};

/**
 * GET /kyc/business/confirm-details?b&a&s[&h]&t — the email button (public).
 *
 * Shows the details and asks. Nothing is saved until the button on this page
 * is pressed: mail scanners open every link in an email, and confirming locks
 * the details for good.
 */
export const confirmDetailsFromEmail = async (req, res) => {
    try {
        const resolved = await resolveDetailsLink(req.query, res);
        if (!resolved) return;
        const { link, business } = resolved;
        const rows = snapshotRows(snapshotOf(business));
        const fields = { b: link.businessId, a: link.action, s: String(link.sentAtMs), ...(link.hash ? { h: link.hash } : {}), t: link.token };
        const other = link.action === 'confirm' ? 'reject' : 'confirm';
        const otherUrl = detailsLink(link.businessId, other, link.sentAtMs, link.hash);

        if (link.action === 'confirm') {
            sendDetailsPage(res, {
                title: 'Confirm your business details',
                tone: 'info',
                message: 'Please check the details below. If everything is right, confirm them.',
                rows,
                note: 'Once you confirm, these details can no longer be edited. To change them later you will need to request re-verification.',
                form: { action: CONFIRM_PATH, fields, label: 'Confirm details', kind: 'confirm' },
                secondary: { href: otherUrl, label: 'Something is wrong' },
            });
        } else {
            sendDetailsPage(res, {
                title: 'Is something wrong?',
                tone: 'info',
                message: 'If any of the details below is not right, tell us. You can then correct it in business settings and we will email you the new details.',
                rows,
                form: { action: CONFIRM_PATH, fields, label: 'Yes, something is wrong', kind: 'reject' },
                secondary: { href: otherUrl, label: 'No, the details are right' },
            });
        }
    } catch (error) {
        detailsPageFailed(res, error);
    }
};

/** POST /kyc/business/confirm-details — the button on that page (public). Saves the answer. */
export const submitDetailsFromEmail = async (req, res) => {
    try {
        const params = req.body && Object.keys(req.body).length ? req.body : req.query;
        const resolved = await resolveDetailsLink(params, res);
        if (!resolved) return;
        const { link, business } = resolved;
        const now = new Date();
        const notify = (message) => notifyActivity({ recipientId: business.userId, type: 'kyc', message })
            // The answer is saved; a notification that cannot be stored must not
            // turn the page into an error.
            .catch((error) => console.warn('[kyc] details notification failed:', error?.message));

        if (link.action === 'confirm') {
            await Business.updateOne({ _id: business._id }, {
                $set: { detailsLocked: true, 'detailsConfirmation.status': 'confirmed', 'detailsConfirmation.respondedAt': now },
            });
            await notify('Your business details are confirmed. They can no longer be edited without re-verification.');
            sendDetailsPage(res, { ...CONFIRMED_PAGE, rows: snapshotRows(snapshotOf(business)) });
            return;
        }

        await Business.updateOne({ _id: business._id }, {
            $set: { detailsLocked: false, 'detailsConfirmation.status': 'rejected', 'detailsConfirmation.respondedAt': now },
        });
        await notify('You said your business details are wrong. Please correct them in business settings and submit again.');
        sendDetailsPage(res, {
            title: 'Thanks for telling us',
            tone: 'info',
            message: 'Please correct your details in business settings and save them. We will email you the new details to confirm.',
        });
    } catch (error) {
        detailsPageFailed(res, error);
    }
};


/** Used by the business profile update: refuses changes to locked fields. */
export const assertNotLocked = (business, touched) => {
    if (business?.detailsLocked && touched.length) {
        const err = new ApiError(423, 'This information can no longer be edited. Request re-verification to change it.');
        err.data = { code: 'DETAILS_LOCKED', fields: touched };
        throw err;
    }
};

// ─── Trust info for chats (#75) ─────────────────────────────────────────────

/** GET /kyc/trust/:userId — verified badge and whether to warn in chat. */
export const getTrustInfo = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) throw new ApiError(400, 'Invalid user id');
    const [user, business] = await Promise.all([
        User.findById(userId).select('isBusinessProfile aadhaarVerification').lean(),
        Business.findOne({ userId }).select('kyc verificationStatus registrationType plan subscriptionStatus businessName').lean(),
    ]);
    if (!user) throw new ApiError(404, 'User not found');
    const isBusiness = !!user.isBusinessProfile;
    const kycStatus = business ? effectiveKycStatus(business) : 'none';
    const verified = isBusiness ? kycStatus === 'verified' : user.aadhaarVerification?.status === 'verified';
    return res.status(200).json(new ApiResponse(200, {
        isBusiness,
        verified,
        badge: business ? badgeOf(business) : (verified ? 'verified_person' : null),
        showUnverifiedWarning: !verified,
        warning: !verified
            ? (isBusiness ? "This business hasn't been verified by Findernate yet. Be careful sharing money or personal details." : "This person hasn't been verified by Findernate. Be careful sharing money or personal details.")
            : null,
        outsidePaymentNotice: 'Payments made outside Findernate are at your own risk. Pay inside the app to be protected.',
    }, 'OK'));
});

// ─── Admin queue (#30) ──────────────────────────────────────────────────────

/** GET /admin/kyc?status=needs_review&page */
export const adminKycQueue = asyncHandler(async (req, res) => {
    const status = String(req.query.status || 'needs_review');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = { 'kyc.status': status };
    const [rows, total] = await Promise.all([
        Business.find(filter).sort({ 'kyc.submittedAt': 1 }).skip((page - 1) * 30).limit(30)
            .select('userId businessName businessType registrationType gstNumber panNumber kyc documents contact location').lean(),
        Business.countDocuments(filter),
    ]);
    // PAN shown to admins as its last four characters only (23 Nov 2026).
    return res.status(200).json(new ApiResponse(200, { items: rows.map(maskBusinessIdsForAdmin), total, page }, 'OK'));
});

/** POST /admin/kyc/:businessId/decision  { decision: 'approve'|'reject', note } */
export const adminKycDecision = asyncHandler(async (req, res) => {
    const business = await Business.findById(req.params.businessId);
    if (!business) throw new ApiError(404, 'Business not found');
    const approve = req.body?.decision === 'approve';
    business.kyc = business.kyc || {};
    business.kyc.status = approve ? 'verified' : 'rejected';
    business.kyc.source = approve ? 'admin' : business.kyc.source;
    business.kyc.reviewedBy = req.admin?._id;
    business.kyc.reasons = approve ? [] : [String(req.body?.note || 'Details could not be verified')];
    if (approve) {
        business.kyc.verifiedAt = new Date();
        business.kyc.recheckDueAt = undefined;
        business.verificationStatus = 'approved';
        business.isVerified = true;
    } else {
        business.verificationStatus = 'rejected';
        business.verificationRemarks = business.kyc.reasons[0];
    }
    business.markModified('kyc');
    await business.save();
    await refreshStoredTier(business.userId);
    await notifyKyc(business.userId, business.kyc.status, business.kyc.reasons);
    if (approve) await maybeSendDetailsConfirmation(business).catch(() => {});
    return res.status(200).json(new ApiResponse(200, { status: business.kyc.status }, approve ? 'Approved' : 'Rejected'));
});

/** For profiles and post cards: badge per user id. */
export const badgesFor = async (userIds) => {
    const { tiers } = await tiersFor(userIds);
    const businesses = await Business.find({ userId: { $in: [...tiers.keys()] } }).select('userId kyc verificationStatus registrationType').lean();
    return new Map(businesses.map((b) => [String(b.userId), badgeOf(b)]));
};
