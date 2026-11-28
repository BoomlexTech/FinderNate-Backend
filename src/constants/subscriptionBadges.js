/**
 * The one palette for the paid-plan badge. Each plan has its own, so a business
 * can be told apart at a glance:
 *
 *   Basic   — bronze
 *   Pro     — green   (the plan first sold as "Small Business")
 *   Premium — purple  (the plan first sold as "Corporate")
 *
 * Blue is deliberately NOT used here: the blue tick belongs to personal
 * accounts on Findernate Plus (see utils/plusBadge.js), and two different blue
 * marks next to a name would read as the same thing.
 *
 * The website and the app read `color` and `label` from the badge the API
 * sends, so changing a colour or a label here changes it everywhere. `type`
 * stays the plan id, which is what older app builds key their own styling on.
 *
 * Free has no badge. Callers get a fresh copy so a response can be edited
 * without touching the shared definition.
 */
const BADGES = {
    basic: { type: 'basic', label: 'Basic', color: '#B45309', isPaid: true },
    small_business: { type: 'small_business', label: 'Pro', color: '#16A34A', isPaid: true },
    corporate: { type: 'corporate', label: 'Premium', color: '#7C3AED', isPaid: true }
};

export const badgeForPlan = (plan) => (BADGES[plan] ? { ...BADGES[plan] } : null);
