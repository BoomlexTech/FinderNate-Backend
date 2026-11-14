import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { normalizeId } from '../utils/phase4.rules.js';

/**
 * Cashfree Verification Suite (Secure ID) for Phase 4 KYC (#30, #74, #79, #80):
 * GSTIN, PAN (with name match) and Aadhaar OTP checks.
 *
 * Environment:
 *   CASHFREE_VERIFY_CLIENT_ID, CASHFREE_VERIFY_CLIENT_SECRET   required
 *   CASHFREE_VERIFY_ENV   'production' or 'sandbox' (default sandbox)
 *
 * Without credentials every function returns { available: false } and the
 * caller sends the business to the admin review queue instead.
 *
 * Responses are read defensively: only the fields we need, with the names
 * Cashfree documents and their common variants.
 */
export const verificationConfigured = () =>
    !!(process.env.CASHFREE_VERIFY_CLIENT_ID && process.env.CASHFREE_VERIFY_CLIENT_SECRET);

const base = () => (process.env.CASHFREE_VERIFY_ENV === 'production'
    ? 'https://api.cashfree.com/verification'
    : 'https://sandbox.cashfree.com/verification');

/** Posts to Cashfree and returns the HTTP status with the body (4xx answers are not thrown). */
const callWithStatus = async (path, body) => {
    const res = await axios.post(`${base()}${path}`, body, {
        headers: {
            'x-client-id': process.env.CASHFREE_VERIFY_CLIENT_ID,
            'x-client-secret': process.env.CASHFREE_VERIFY_CLIENT_SECRET,
            'Content-Type': 'application/json',
        },
        timeout: 20000,
        validateStatus: (s) => s < 500,
    });
    return { status: res.status, data: res.data || {} };
};

const call = async (path, body) => (await callWithStatus(path, body)).data;

const pick = (o, ...keys) => {
    for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== '') return o[k];
    return undefined;
};

/** GSTIN lookup: valid, active, legal and trade names. */
export const verifyGstin = async (gstin, businessName) => {
    if (!verificationConfigured()) return { available: false };
    const d = await call('/gstin', { GSTIN: normalizeId(gstin), business_name: businessName || undefined });
    const status = String(pick(d, 'gst_in_status', 'gstin_status', 'status') || '');
    return {
        available: true,
        valid: d.valid === true || /active/i.test(status),
        active: /^active$/i.test(status),
        legalName: pick(d, 'legal_name_of_business', 'legal_name'),
        tradeName: pick(d, 'trade_name_of_business', 'trade_name'),
        pan: normalizeId(gstin).slice(2, 12),
        refId: String(pick(d, 'reference_id', 'ref_id') || ''),
        message: pick(d, 'message'),
    };
};

/** PAN lookup with the name on record. */
export const verifyPan = async (pan, name) => {
    if (!verificationConfigured()) return { available: false };
    const d = await call('/pan', { pan: normalizeId(pan), name: name || undefined });
    return {
        available: true,
        valid: d.valid === true || /valid/i.test(String(d.status || '')),
        name: pick(d, 'registered_name', 'name_pan_card', 'name'),
        pan: normalizeId(pan),
        refId: String(pick(d, 'reference_id', 'ref_id') || ''),
        message: pick(d, 'message'),
    };
};

/**
 * IFSC lookup (Cashfree "IFSC Verification V2", POST /ifsc): is this a real
 * branch code, and which bank and branch is it?
 *
 * Never throws. `outcome` is what the caller acts on:
 *   'valid'        the code exists; bank, branch, city and state are filled in
 *   'invalid'      Cashfree says the code does not exist (404 ifsc_not_found, or a
 *                  400 ifsc_value_invalid on a code in Cashfree's own format)
 *   'unavailable'  the check could not be made: no credentials, a wrong key, IP not
 *                  whitelisted, no balance, rate limit, Cashfree down, or a timeout.
 *                  A seller is never blocked because of this.
 *
 * Cashfree documents the last 6 characters as digits, but real IFSCs of some
 * cooperative and rural banks carry letters there. A 400 on such a code is
 * therefore "could not check", not "invalid".
 */
export const verifyIfsc = async (ifsc) => {
    if (!verificationConfigured()) return { available: false, outcome: 'unavailable' };
    const code = String(ifsc || '').trim().toUpperCase();
    try {
        const { status, data } = await callWithStatus('/ifsc', {
            verification_id: `ifsc${Date.now().toString(36)}${randomBytes(6).toString('hex')}`,
            ifsc: code,
        });
        const errCode = String(data?.code || '');

        if (status === 200 && /^valid$/i.test(String(data?.status || ''))) {
            return {
                available: true,
                outcome: 'valid',
                valid: true,
                bank: pick(data, 'bank'),
                branch: pick(data, 'branch'),
                city: pick(data, 'city'),
                state: pick(data, 'state'),
                address: pick(data, 'address'),
                micr: pick(data, 'micr'),
                refId: String(pick(data, 'reference_id') || ''),
            };
        }
        if (status === 404 && errCode === 'ifsc_not_found') {
            return { available: true, outcome: 'invalid', valid: false, code: errCode, message: 'We could not find this IFSC code. Check it and try again.' };
        }
        if (status === 400 && errCode === 'ifsc_value_invalid') {
            const cashfreeFormat = /^[A-Z]{4}0\d{6}$/.test(code);
            return cashfreeFormat
                ? { available: true, outcome: 'invalid', valid: false, code: errCode, message: 'This IFSC code is not valid. Check it and try again.' }
                : { available: true, outcome: 'unavailable', code: errCode };
        }
        // 401 wrong key, 403 IP not whitelisted, 422 no balance, 429 rate limit,
        // and anything else: we could not check, so the caller carries on.
        console.warn(`[cashfree ifsc] could not verify: HTTP ${status}${errCode ? ` ${errCode}` : ''}`);
        return { available: true, outcome: 'unavailable', code: errCode || String(status) };
    } catch (err) {
        console.warn(`[cashfree ifsc] could not verify: ${err?.code || err?.message || 'request failed'}`);
        return { available: true, outcome: 'unavailable', code: 'request_failed' };
    }
};

/**
 * Turns Cashfree / UIDAI answers into sentences a person can act on. The raw
 * messages ("verification_failed", "Invalid ref id", HTTP 5xx) were shown as
 * they were, or as a bare server error (client feedback #74).
 */
export const aadhaarMessage = (status, data, fallback) => {
    const raw = `${data?.code || ''} ${data?.message || ''}`.toLowerCase();
    if (/expired|timed? ?out/.test(raw)) return 'This OTP has expired. Tap "Resend OTP" to get a new one.';
    if (/invalid otp|incorrect otp|otp.*(invalid|incorrect|wrong|mismatch)/.test(raw)) return 'The OTP is not correct. Check the SMS and try again.';
    if (/ref.?id/.test(raw)) return 'This OTP request is no longer valid. Tap "Resend OTP" to get a new one.';
    if (/(wait|too many|frequent|rate|45 sec|retry after)/.test(raw) || status === 429) return 'Please wait a minute before asking for another OTP.';
    if (/not linked|no mobile|mobile.*not/.test(raw)) return 'No mobile number is linked to this Aadhaar. Link one at an Aadhaar centre, then try again.';
    if (/invalid aadhaar|aadhaar.*(invalid|not valid|does not exist)/.test(raw)) return 'This Aadhaar number is not valid. Check it and try again.';
    if (status === 401 || status === 403) return 'Aadhaar verification is not available right now. Please try again later.';
    if (status === 422 || /balance|insufficient/.test(raw)) return 'Aadhaar verification is not available right now. Please try again later.';
    return data?.message || fallback;
};

const busy = { available: true, ok: false, valid: false, message: 'The Aadhaar service is busy right now. Please try again in a minute.' };

/** Sends an OTP to the mobile number linked to the Aadhaar. */
export const sendAadhaarOtp = async (aadhaarNumber) => {
    if (!verificationConfigured()) return { available: false };
    const digits = String(aadhaarNumber || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(digits)) return { available: true, ok: false, message: 'Enter the 12-digit Aadhaar number' };
    try {
        const { status, data } = await callWithStatus('/offline-aadhaar/otp', { aadhaar_number: digits });
        const refId = String(pick(data, 'ref_id', 'reference_id') || '');
        if (status === 200 && refId) return { available: true, ok: true, refId, last4: digits.slice(-4), message: pick(data, 'message') };
        console.warn(`[cashfree aadhaar otp] HTTP ${status} ${data?.code || ''} ${data?.message || ''}`);
        return { available: true, ok: false, message: aadhaarMessage(status, data, "We couldn't send the OTP. Please try again.") };
    } catch (err) {
        console.warn(`[cashfree aadhaar otp] ${err?.code || err?.message || 'request failed'}`);
        return busy;
    }
};

/** Checks the OTP and returns the name on the Aadhaar. */
export const verifyAadhaarOtp = async (refId, otp) => {
    if (!verificationConfigured()) return { available: false };
    const code = String(otp || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return { available: true, valid: false, message: 'Enter the 6-digit OTP from the SMS' };
    if (!refId) return { available: true, valid: false, message: 'Tap "Send OTP" first.' };
    try {
        const { status, data } = await callWithStatus('/offline-aadhaar/verify', { ref_id: String(refId), otp: code });
        const valid = status === 200 && (/^valid$/i.test(String(data.status || '')) || data.valid === true);
        if (!valid) console.warn(`[cashfree aadhaar verify] HTTP ${status} ${data?.code || ''} ${data?.status || ''} ${data?.message || ''}`);
        return {
            available: true,
            valid,
            name: pick(data, 'name'),
            refId: String(pick(data, 'ref_id', 'reference_id') || refId),
            message: valid ? pick(data, 'message') : aadhaarMessage(status, data, 'The OTP is not correct. Check the SMS and try again.'),
        };
    } catch (err) {
        console.warn(`[cashfree aadhaar verify] ${err?.code || err?.message || 'request failed'}`);
        return busy;
    }
};
