/**
 * The wording of the business verification notices (bell list and push).
 *
 * Client, 25 Nov 2026: being verified is good news and should read like it,
 * and the notices should not talk about re-verification. Re-verification is
 * offered where it applies instead: in business settings, under the fields
 * that are locked.
 */

export const KYC_VERIFIED_NOTICE = 'Congratulations! Your business account is verified.';

export const KYC_DETAILS_CONFIRMED_NOTICE = 'Your business details are confirmed.';

/**
 * The wording these two notices had until 25 Nov 2026. Notices are stored as
 * text, so the ones already sent still hold it; they are shown with today's
 * wording instead (see currentKycNotice).
 */
const RETIRED_WORDING = new Map([
    [
        'Your business is verified. Your product, service and business posts can now be seen by your followers, and by everyone with an active plan.',
        KYC_VERIFIED_NOTICE,
    ],
    [
        'Your business details are confirmed. They can no longer be edited without re-verification.',
        KYC_DETAILS_CONFIRMED_NOTICE,
    ],
]);

/** Today's wording for a stored notice message; anything else is returned as it is. */
export const currentKycNotice = (message) => RETIRED_WORDING.get(String(message ?? '').trim()) || message;

/** Rewrites the retired wording in a page of notifications, in place. */
export const withCurrentKycWording = (notifications = []) => {
    for (const n of notifications) {
        if (n && n.type === 'kyc' && n.message) n.message = currentKycNotice(n.message);
    }
    return notifications;
};
