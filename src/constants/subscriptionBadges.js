/**
 * The one palette for the paid-plan badge: green for Small Business, blue for
 * Corporate. The website and the app read `color` and `label` from the badge the
 * API sends, so changing a colour here changes it everywhere.
 *
 * Free has no badge. Callers get a fresh copy so a response can be edited
 * without touching the shared definition.
 */
const BADGES = {
    small_business: { type: 'small_business', label: 'Small Business', color: '#22C55E', isPaid: true },
    corporate: { type: 'corporate', label: 'Corporate', color: '#3B82F6', isPaid: true }
};

export const badgeForPlan = (plan) => (BADGES[plan] ? { ...BADGES[plan] } : null);
