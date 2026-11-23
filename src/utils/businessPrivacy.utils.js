import { maskId } from './phase4.rules.js';

// What a Business record may show, and to whom, for the government ID numbers
// it holds (client, 23 Nov 2026: "can the super admin see the full PAN? if yes,
// mask it" — then the same for Aadhaar).

const plain = (business) =>
    business && typeof business.toObject === 'function' ? business.toObject() : business;

/**
 * A GSTIN with the PAN inside it masked: characters 3–12 of a GSTIN ARE the
 * holder's PAN, so a full GSTIN next to a masked PAN gave the PAN away. Keeps
 * the state code, the PAN's last four (the same four the masked PAN shows) and
 * the last three characters: "29••••••234F1Z5".
 */
export const maskGstin = (gstin) => {
    const g = String(gstin || '').toUpperCase().replace(/\s+/g, '');
    if (g.length !== 15) return g ? maskId(g, 4) : g;
    return `${g.slice(0, 2)}${'•'.repeat(6)}${g.slice(8)}`;
};

/**
 * The record as the admin panel gets it: the PAN shows only its last four
 * characters. It is stored three times — `panNumber` and inside the saved
 * Cashfree check results (`kyc.checks.pan.pan`, `kyc.checks.gst.pan`, the PAN
 * inside a GSTIN) — and all three are masked, as is the PAN part of the GSTIN
 * itself ([maskGstin]). The legacy full Aadhaar number (`aadhaarNumber`, from
 * the pre-Phase-4 manual review) keeps only its last four digits as well; the
 * admin compares those with the uploaded card. The names on the PAN / GST stay:
 * the admin compares them when a check needs a human. Returns a new object.
 */
export const maskBusinessIdsForAdmin = (business) => {
    const b = plain(business);
    if (!b || typeof b !== 'object') return b;
    const out = { ...b };
    if (out.panNumber) out.panNumber = maskId(out.panNumber, 4);
    if (out.gstNumber) out.gstNumber = maskGstin(out.gstNumber);
    if (out.aadhaarNumber) out.aadhaarNumber = maskId(String(out.aadhaarNumber), 4);
    const checks = out.kyc?.checks;
    if (checks) {
        const c = { ...checks };
        if (c.pan?.pan) c.pan = { ...c.pan, pan: maskId(c.pan.pan, 4) };
        if (c.gst?.pan) c.gst = { ...c.gst, pan: maskId(c.gst.pan, 4) };
        out.kyc = { ...out.kyc, checks: c };
    }
    // The copy of the details e-mailed to the owner keeps the full GSTIN (the
    // owner's own e-mail shows it); the admin gets it masked like the rest.
    const snap = out.detailsConfirmation?.snapshot;
    if (snap && typeof snap === 'object') {
        const s = { ...snap };
        if (s.gstNumber) s.gstNumber = maskGstin(s.gstNumber);
        if (s.panNumber) s.panNumber = maskId(s.panNumber, 4);
        out.detailsConfirmation = { ...out.detailsConfirmation, snapshot: s };
    }
    return out;
};

/**
 * Removes, from a business record about to go to someone who is not its owner,
 * everything KYC added that a stranger must never see: the PAN; the check
 * results (the PAN again, the names on the PAN and the Aadhaar, the Aadhaar's
 * last digits); the e-mailed details snapshot (owner's phone, email, address);
 * the admin's remarks. Only the KYC status stays. Mutates and returns
 * [publicBusiness], which must already be a copy.
 *
 * The public strippers in controllers/business predate KYC, so all of this was
 * served to anyone who knew a business id — no sign-in needed.
 */
export const stripKycForPublic = (publicBusiness) => {
    if (!publicBusiness || typeof publicBusiness !== 'object') return publicBusiness;
    delete publicBusiness.panNumber;
    delete publicBusiness.detailsConfirmation;
    delete publicBusiness.verificationRemarks;
    if (publicBusiness.kyc) publicBusiness.kyc = { status: publicBusiness.kyc.status };
    return publicBusiness;
};

/**
 * Admin-search clauses for the ID numbers the admin panel shows masked: only a
 * whole Aadhaar number (12 digits, spaced or not) or a whole GSTIN finds a
 * business. These were partial-match regexes, and a search box that answers
 * "is there an Aadhaar starting 4…?" gives a masked number back one digit at
 * a time. Returns [] for anything else, so it can be spread into an `$or`.
 */
export const exactIdSearchClauses = (search) => {
    const q = String(search ?? '').replace(/[\s-]+/g, '').toUpperCase();
    const clauses = [];
    if (/^\d{12}$/.test(q)) {
        clauses.push({ aadhaarNumber: { $in: [q, q.replace(/(\d{4})(?=\d)/g, '$1 ')] } });
    }
    if (/^[0-9A-Z]{15}$/.test(q)) {
        clauses.push({ gstNumber: { $regex: `^${q}$`, $options: 'i' } });
    }
    return clauses;
};
