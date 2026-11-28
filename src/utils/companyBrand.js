/**
 * The Findernate logo as a public address, for a notification that comes from
 * Findernate itself and not from a person: a plan notice, a verification
 * notice, an announcement, "update available" (client list, 28 Nov 2026,
 * item 20). A person's notification shows that person; these show the company.
 *
 * It is the website's own icon, so it is the same picture everywhere and there
 * is nothing extra to host. COMPANY_LOGO_URL overrides it.
 */
export const companyLogoUrl = () => {
    const override = String(process.env.COMPANY_LOGO_URL || '').trim();
    if (override) return override;
    const site = String(process.env.FRONTEND_URL || 'https://findernate.com').trim().replace(/\/+$/, '');
    return `${site}/icon-192x192.png`;
};

/**
 * The logo, but only when a phone can actually fetch it. Android downloads the
 * picture of a push before showing it, over https; an address it cannot reach
 * (a developer's http://localhost) is left out rather than slowing every push.
 */
export const companyLogoForPush = () => {
    const url = companyLogoUrl();
    return /^https:\/\//i.test(url) ? url : null;
};

/** True when a push is from Findernate itself: nobody sent it. */
export const isCompanyPush = (data = {}) => !data?.senderId;
