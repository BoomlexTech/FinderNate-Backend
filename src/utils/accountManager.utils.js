/**
 * Corporate account-manager rules, free of the database so they can be tested
 * on their own.
 *
 * "Assigned" means a name or an email is on file, the same test the business-
 * facing subscription status uses to decide between the contact card and the
 * "being assigned" message.
 */

// `$in: [null, '']` also matches a missing field, which is every Corporate
// account that existed before the field did.
export const UNASSIGNED_MANAGER_FILTER = {
    'accountManager.name': { $in: [null, ''] },
    'accountManager.email': { $in: [null, ''] }
};

export const hasAccountManager = (business) =>
    !!(business?.accountManager?.name || business?.accountManager?.email);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+()\-\s]{6,20}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Validates what the admin typed into the Assign modal.
 * Returns `{ manager }` on success or `{ error }` with a message for the admin.
 * The manager need not be an admin user, so contact details are copied in.
 */
export const parseAccountManagerInput = (body = {}) => {
    const name = text(body.name);
    const email = text(body.email).toLowerCase();
    const phone = text(body.phone);
    const hours = text(body.hours);

    if (!name) return { error: 'Manager name is required' };
    if (name.length > 100) return { error: 'Manager name must be 100 characters or fewer' };
    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
        return { error: 'A valid manager email is required' };
    }
    if (phone && !PHONE_PATTERN.test(phone)) return { error: 'Manager phone number is not valid' };
    if (hours.length > 100) return { error: 'Contact hours must be 100 characters or fewer' };

    return { manager: { name, email, phone, hours } };
};

/**
 * Should activating `plan` tell the owner a Corporate account needs a manager?
 *
 * Only when this activation starts Corporate (a new purchase, a switch from
 * Small Business, or a return after a lapse). A same-plan renewal of an account
 * that is still unassigned is not a "new subscriber" and would otherwise repeat
 * the alert every month.
 */
export const needsAccountManagerAlert = ({ plan, previousPlan, previousStatus, business }) =>
    plan === 'corporate'
    && !(previousPlan === 'corporate' && previousStatus === 'active')
    && !hasAccountManager(business);
