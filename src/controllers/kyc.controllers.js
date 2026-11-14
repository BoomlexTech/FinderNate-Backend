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
import {
    decideKyc, effectiveKycStatus, isValidGstin, isValidPan, maskId, normalizeId, panFromGstin,
    visibilityTier, LOCKED_FIELDS,
} from '../utils/phase4.rules.js';
import {
    verificationConfigured, verifyGstin, verifyPan, sendAadhaarOtp, verifyAadhaarOtp,
} from '../services/cashfreeVerify.service.js';

/**
 * Business KYC (Phase 4 #79, #30, #4, #74). See docs/PHASE4_API.md.
 */

const loadBusiness = async (userId) => {
    const business = await Business.findOne({ userId });
    if (!business) throw new ApiError(404, 'Create your business profile first');
    return business;
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
    business.kyc = business.kyc || {};
    business.kyc.submittedAt = new Date();

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
    business.kyc.checks = {
        ...(business.kyc.checks || {}),
        ...(gst?.available ? { gst: { ...gst, checkedAt: now } } : {}),
        ...(panRes?.available ? { pan: { ...panRes, checkedAt: now } } : {}),
    };

    let decision;
    if (!verificationConfigured() || (gstin && !gst?.available) || !panRes?.available) {
        decision = { status: 'needs_review', reasons: ['Automatic checks are not available; an admin will review your details'] };
    } else {
        decision = decideKyc({
            registrationType, gst, pan: panRes, aadhaar: business.kyc.checks?.aadhaar, businessName: business.businessName,
        });
    }
    business.kyc.status = decision.status;
    business.kyc.reasons = decision.reasons;
    business.kyc.source = decision.status === 'verified' ? 'auto' : business.kyc.source;
    if (decision.status === 'verified') {
        business.kyc.verifiedAt = now;
        business.kyc.recheckDueAt = undefined;
        business.verificationStatus = 'approved';
        business.isVerified = true;
    }
    business.markModified('kyc');
    await business.save();
    await refreshStoredTier(req.user._id);
    await notifyKyc(req.user._id, decision.status, decision.reasons);
    if (decision.status === 'verified') await maybeSendDetailsConfirmation(business).catch(() => {});

    return res.status(200).json(new ApiResponse(200, publicKyc(business), decision.status === 'verified' ? 'Your business is verified' : 'Submitted for review'));
});

/** POST /kyc/business/aadhaar/otp  { aadhaar } (unregistered businesses) */
export const businessAadhaarOtp = asyncHandler(async (req, res) => {
    await loadBusiness(req.user._id);
    const r = await sendAadhaarOtp(req.body?.aadhaar);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.ok) throw new ApiError(400, r.message || "Couldn't send the OTP");
    return res.status(200).json(new ApiResponse(200, { refId: r.refId, last4: r.last4 }, 'OTP sent to the mobile linked to your Aadhaar'));
});

/** POST /kyc/business/aadhaar/verify  { refId, otp, last4 } */
export const businessAadhaarVerify = asyncHandler(async (req, res) => {
    const business = await loadBusiness(req.user._id);
    const r = await verifyAadhaarOtp(req.body?.refId, req.body?.otp);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.valid) throw new ApiError(400, r.message || 'The OTP is not correct');
    business.kyc = business.kyc || {};
    business.kyc.checks = { ...(business.kyc.checks || {}), aadhaar: { valid: true, name: r.name, last4: String(req.body?.last4 || '').slice(-4), refId: r.refId, checkedAt: new Date() } };
    business.markModified('kyc');
    await business.save();
    return res.status(200).json(new ApiResponse(200, { valid: true, name: r.name }, 'Aadhaar verified'));
});

// ─── Regular users' Aadhaar (#80 listings) ──────────────────────────────────

/** POST /kyc/me/aadhaar/otp  { aadhaar } */
export const userAadhaarOtp = asyncHandler(async (req, res) => {
    const r = await sendAadhaarOtp(req.body?.aadhaar);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.ok) throw new ApiError(400, r.message || "Couldn't send the OTP");
    return res.status(200).json(new ApiResponse(200, { refId: r.refId, last4: r.last4 }, 'OTP sent'));
});

/** POST /kyc/me/aadhaar/verify  { refId, otp, last4 } */
export const userAadhaarVerify = asyncHandler(async (req, res) => {
    const r = await verifyAadhaarOtp(req.body?.refId, req.body?.otp);
    if (!r.available) throw new ApiError(503, 'Aadhaar verification is not available yet');
    if (!r.valid) throw new ApiError(400, r.message || 'The OTP is not correct');
    await User.updateOne({ _id: req.user._id }, {
        $set: { aadhaarVerification: { status: 'verified', name: r.name, last4: String(req.body?.last4 || '').slice(-4), refId: r.refId, verifiedAt: new Date() } },
    });
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

export const detailsToken = (businessId, action, sentAt) => crypto
    .createHmac('sha256', signingSecret())
    .update(`${businessId}:${action}:${new Date(sentAt).getTime()}`)
    .digest('hex')
    .slice(0, 32);

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

const sameSnapshot = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/** @returns {Promise<{sent: boolean, to?: string, reason?: string}>} */
export const sendDetailsConfirmation = async (business) => {
    const user = await User.findById(business.userId).select('email fullName').lean();
    const to = business.contact?.email || user?.email;
    if (!to) return { sent: false, reason: 'no_email' };
    const sentAt = new Date();
    const api = process.env.BACKEND_URL || 'https://apis.findernate.com';
    const link = (action) => `${api}/api/v1/kyc/business/confirm-details?b=${business._id}&a=${action}&s=${sentAt.getTime()}&t=${detailsToken(business._id, action, sentAt)}`;
    const snap = snapshotOf(business);
    const rows = [
        ['Business name', snap.businessName], ['Business type', snap.businessType], ['Category', snap.category],
        ['Description', snap.description], ['Phone', snap.phone], ['Email', snap.email], ['Address', snap.address],
        ['Registration', snap.registrationType ? (snap.registrationType === 'registered' ? 'Registered (GST)' : 'Unregistered') : null],
        ['GSTIN', snap.gstNumber], ['PAN', snap.panNumber], ['Aadhaar', snap.aadhaar],
    ].filter(([, v]) => v);
    const button = (href, label, bg, fg) => `<a href="${href}" style="display:inline-block;padding:12px 22px;margin:4px 6px 4px 0;border-radius:8px;background:${bg};color:${fg};text-decoration:none;font-weight:600">${label}</a>`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
<p>Hi ${escapeHtml(user?.fullName || '')},</p>
<p>You submitted these business details on Findernate. Please check them and tell us if they are right.</p>
<table cellpadding="8" style="border-collapse:collapse;width:100%;border:1px solid #eee">${rows.map(([k, v]) => `<tr><td style="border-bottom:1px solid #eee;width:35%"><b>${escapeHtml(k)}</b></td><td style="border-bottom:1px solid #eee">${escapeHtml(v)}</td></tr>`).join('')}</table>
<p style="margin-top:18px">${button(link('confirm'), 'Confirm details', '#16a34a', '#fff')}${button(link('reject'), 'Reject, something is wrong', '#f3f4f6', '#111')}</p>
<p style="color:#555;font-size:13px">Once you confirm, these details can no longer be edited. To change them later you will need to request re-verification.</p>
</div>`;
    const text = `You submitted these business details on Findernate:\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nConfirm: ${link('confirm')}\nReject: ${link('reject')}\n\nOnce you confirm, these details can no longer be edited.`;
    const result = await sendEmail({ to, subject: 'Please confirm your business details on Findernate', html, text });
    if (result && result.success === false) {
        console.warn('[kyc] details confirmation email failed:', result.error);
        return { sent: false, to, reason: 'send_failed' };
    }
    business.detailsConfirmation = { status: 'sent', sentAt, snapshot: snap };
    await Business.updateOne({ _id: business._id }, { $set: { detailsConfirmation: business.detailsConfirmation } });
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

/** GET /kyc/business/confirm-details?b&a&s&t — the email link (public). */
export const confirmDetailsFromEmail = asyncHandler(async (req, res) => {
    const { b, a, s, t } = req.query;
    const page = (title, msg) => res.status(200).type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px"><h2>${title}</h2><p>${msg}</p><p><a href="${process.env.FRONTEND_URL || 'https://findernate.com'}/settings/business">Open business settings</a></p></body>`);
    if (!mongoose.Types.ObjectId.isValid(b) || !['confirm', 'reject'].includes(a)) return page('Link not valid', 'This link is broken.');
    const business = await Business.findById(b);
    const sentAt = business?.detailsConfirmation?.sentAt;
    if (!business || !sentAt || String(new Date(sentAt).getTime()) !== String(s)) return page('Link expired', 'A newer email was sent, or this link was already used.');
    const expected = detailsToken(business._id, a, sentAt);
    if (!t || t.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(expected))) return page('Link not valid', 'This link is broken.');
    if (business.detailsConfirmation.status !== 'sent') return page('Already answered', 'You have already responded to this email.');

    if (a === 'confirm') {
        await Business.updateOne({ _id: business._id }, { $set: { detailsLocked: true, 'detailsConfirmation.status': 'confirmed', 'detailsConfirmation.respondedAt': new Date() } });
        await notifyActivity({ recipientId: business.userId, type: 'kyc', message: 'Your business details are confirmed. They can no longer be edited without re-verification.' });
        return page('Details confirmed', 'Thank you. Your business details are confirmed and this information can no longer be edited. To change it later, request re-verification in business settings.');
    }
    await Business.updateOne({ _id: business._id }, { $set: { detailsLocked: false, 'detailsConfirmation.status': 'rejected', 'detailsConfirmation.respondedAt': new Date() } });
    await notifyActivity({ recipientId: business.userId, type: 'kyc', message: 'You said your business details are wrong. Please correct them in business settings and submit again.' });
    return page('Thanks for telling us', 'Please correct your details in business settings and submit them again.');
});

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
    return res.status(200).json(new ApiResponse(200, { items: rows, total, page }, 'OK'));
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
