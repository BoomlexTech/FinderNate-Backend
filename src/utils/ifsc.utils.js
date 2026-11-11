import { verifyIfsc } from '../services/cashfreeVerify.service.js';

/**
 * What to do with the IFSC a seller types into their bank details.
 *
 * Each lookup costs a Cashfree verification credit, so it only runs when the IFSC
 * is new or changed: editing a UPI id or a branch name does not spend one.
 *
 * Returns
 *   { checked: false }                     nothing was checked (unchanged, no
 *                                          credentials, or Cashfree could not answer):
 *                                          the caller saves as before
 *   { checked: true, valid: false, message }   the code does not exist: refuse it
 *   { checked: true, valid: true, bank, branch }   the code exists
 *
 * `verify` can be replaced in tests.
 */
export const checkIfscOnSave = async ({ ifsc, previousIfsc, verify = verifyIfsc }) => {
    const code = String(ifsc || '').trim().toUpperCase();
    if (!code || code === String(previousIfsc || '').trim().toUpperCase()) return { checked: false };

    const r = await verify(code);
    if (!r || !r.available || r.outcome === 'unavailable') return { checked: false };
    if (r.outcome === 'invalid') return { checked: true, valid: false, message: r.message };
    return { checked: true, valid: true, bank: r.bank, branch: r.branch };
};
