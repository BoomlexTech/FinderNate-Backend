import axios from 'axios';
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

const call = async (path, body) => {
    const { data } = await axios.post(`${base()}${path}`, body, {
        headers: {
            'x-client-id': process.env.CASHFREE_VERIFY_CLIENT_ID,
            'x-client-secret': process.env.CASHFREE_VERIFY_CLIENT_SECRET,
            'Content-Type': 'application/json',
        },
        timeout: 20000,
        validateStatus: (s) => s < 500,
    });
    return data || {};
};

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

/** Sends an OTP to the mobile number linked to the Aadhaar. */
export const sendAadhaarOtp = async (aadhaarNumber) => {
    if (!verificationConfigured()) return { available: false };
    const digits = String(aadhaarNumber || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(digits)) return { available: true, ok: false, message: 'Enter the 12-digit Aadhaar number' };
    const d = await call('/offline-aadhaar/otp', { aadhaar_number: digits });
    const refId = String(pick(d, 'ref_id', 'reference_id') || '');
    return { available: true, ok: !!refId, refId, last4: digits.slice(-4), message: pick(d, 'message') };
};

/** Checks the OTP and returns the name on the Aadhaar. */
export const verifyAadhaarOtp = async (refId, otp) => {
    if (!verificationConfigured()) return { available: false };
    const d = await call('/offline-aadhaar/verify', { ref_id: String(refId), otp: String(otp) });
    return {
        available: true,
        valid: /^valid$/i.test(String(d.status || '')) || d.valid === true,
        name: pick(d, 'name'),
        refId: String(pick(d, 'ref_id', 'reference_id') || refId),
        message: pick(d, 'message'),
    };
};
