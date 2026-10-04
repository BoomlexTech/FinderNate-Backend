import { TIER_NAMES } from './planLimits.js';

/**
 * The words, dates and day-counting behind every plan notice a business gets.
 * Pure on purpose (no database, no clock unless one is passed in): what the
 * notice SAYS is decided here, and who it is sent to and how lives in
 * createSubscriptionNotification (notification.controllers.js).
 */

export const SUBSCRIPTION_EVENTS = Object.freeze([
    'ending_soon',
    'plan_changed',
    'downgrade_scheduled',
    'renewal_cancelled',
    'plan_ended',
    'plan_extended'
]);

/** How many days before the end of a plan that will not renew we remind. */
export const REMINDER_DAYS = Object.freeze([7, 3, 1]);

/** Of those, the ones that also go out by email. In-app and push go out for all. */
const EMAIL_REMINDER_DAYS = new Set([7, 1]);

const DAY_MS = 24 * 60 * 60 * 1000;

// India has no daylight saving, so IST is a fixed +05:30 and plain arithmetic is
// exact. Done by hand rather than with Intl on purpose: the abbreviation Intl
// gives for a month depends on the ICU build and locale data (en-GB writes
// "Sept"), and a date in a notice should read the same on every server.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const validTime = (date) => {
    if (!date) return null;
    const time = new Date(date).getTime();
    return Number.isNaN(time) ? null : time;
};

/** "20 Oct 2026", as the date falls in India, or null when there is no usable date. */
export const formatIstDate = (date) => {
    const time = validTime(date);
    if (time === null) return null;
    const ist = new Date(time + IST_OFFSET_MS);
    return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
};

/**
 * Whole calendar days, in India, from [now] to [endDate]: 7 means "the plan ends
 * on the date a week from today", whatever the time of day either falls at. The
 * reminder job runs once a day, so counting calendar days gives each plan exactly
 * one run per count, which counting 24-hour blocks from the endDate's time of day
 * does not (a plan ending at 23:30 would be "7 days away" on a different morning
 * than one ending at 08:00).
 */
export const istDaysUntil = (endDate, now = new Date()) => {
    const end = validTime(endDate);
    if (end === null) return null;
    return Math.floor((end + IST_OFFSET_MS) / DAY_MS) - Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS);
};

const planLabel = (plan) => TIER_NAMES[plan] || String(plan || 'paid');

/**
 * Waits for [promise] but never longer than [ms]: resolves with its value, or with
 * undefined once the time is up (after calling [onTimeout]). It does not cancel
 * the work, it only stops waiting for it. A rejection still rejects, so callers
 * that must not throw give the work its own catch (as every send here does).
 *
 * What it is for: a send that hangs (a mail host that never answers has no
 * timeout shorter than minutes) must not hold up the rest of a loop of users.
 */
export const settleWithin = (promise, ms, onTimeout) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { onTimeout?.(); } catch { /* a logger must not break the wait */ }
            resolve(undefined);
        }, ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });

const TITLES = {
    ending_soon: 'Your plan ends soon',
    plan_changed: 'Your plan changed',
    downgrade_scheduled: 'Plan change scheduled',
    renewal_cancelled: 'Plan will not renew',
    plan_ended: 'Your plan has ended',
    plan_extended: 'Plan extended'
};

/**
 * What a notice says, and whether it is also an email.
 *
 * @param {object}  opts
 * @param {string}  opts.event       one of SUBSCRIPTION_EVENTS
 * @param {string}  opts.plan        the plan the notice is about (the CURRENT plan;
 *                                   for a scheduled downgrade, the one being left)
 * @param {string}  [opts.pendingPlan] downgrade_scheduled only: the plan it moves to
 * @param {Date}    [opts.endDate]   when the plan ends, or for downgrade_scheduled
 *                                   when the switch happens
 * @param {string}  [opts.source]    ending_soon only: 'cashfree' | 'google_play'
 * @param {number}  [opts.daysLeft]  ending_soon only: calendar days left (istDaysUntil)
 * @param {string}  [opts.reason]    plan_ended only: 'on_hold' | 'paused' when Google
 *                                   Play ended the plan for one of those; absent for
 *                                   a plan that simply ran out
 * @returns {{event, title, message, email: null | {subject, title, preheader, paragraphs, callout}}|null}
 *          null for an event this does not know.
 */
export const buildSubscriptionNotice = ({ event, plan, pendingPlan, endDate, source, daysLeft, reason }) => {
    const title = TITLES[event];
    if (!title) return null;

    const planName = planLabel(plan);
    const date = formatIstDate(endDate);

    switch (event) {
        case 'ending_soon': {
            const when = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
            const keep = source === 'google_play'
                ? 'Resubscribe in Google Play to keep it.'
                : 'Pay again before it ends (app or findernate.com) to keep it.';
            const ends = date
                ? `Your ${planName} plan ends ${when}, on ${date}, and then moves to Free.`
                : `Your ${planName} plan ends ${when} and then moves to Free.`;
            return {
                event,
                title,
                message: `${ends} ${keep}`,
                email: EMAIL_REMINDER_DAYS.has(daysLeft)
                    ? {
                        subject: date ? `Your Findernate ${planName} plan ends on ${date}` : `Your Findernate ${planName} plan ends soon`,
                        title: `Your ${planName} plan ends soon`,
                        preheader: date ? `Your ${planName} plan ends on ${date}.` : `Your ${planName} plan ends soon.`,
                        paragraphs: [ends],
                        callout: keep
                    }
                    : null
            };
        }

        case 'plan_changed':
            return {
                event,
                title,
                message: date ? `You are now on ${planName}. Active until ${date}.` : `You are now on ${planName}.`,
                email: null
            };

        case 'downgrade_scheduled': {
            const to = planLabel(pendingPlan);
            return {
                event,
                title,
                message: `Your plan will switch from ${planName} to ${to} ${date ? `on ${date}` : 'at the end of this period'}. You keep ${planName} until then.`,
                email: null
            };
        }

        case 'renewal_cancelled': {
            const stays = date ? `It stays active until ${date}, then moves to Free.` : 'It stays active until the end of this period, then moves to Free.';
            return {
                event,
                title,
                message: `Your ${planName} plan will not renew. ${stays}`,
                email: {
                    subject: `Your Findernate ${planName} plan will not renew`,
                    title: `Your ${planName} plan will not renew`,
                    preheader: date ? `It stays active until ${date}.` : 'It stays active until the end of this period.',
                    paragraphs: [`Your ${planName} plan will not renew.`, stays],
                    callout: 'Changed your mind? Resubscribe in Google Play before it ends to keep the plan.'
                }
            };
        }

        case 'plan_ended':
            // Google Play also reports a failed payment (ON_HOLD) and a pause the
            // user chose (PAUSED) as "over". Both end the entitlement, but neither
            // is an ending: telling them "ended" hides that fixing the card, or
            // waiting for the pause to run out, brings the plan back. The event
            // stays plan_ended (clients switch on it); only the words differ.
            if (reason === 'on_hold') {
                const held = `Your ${planName} plan is on hold because the last payment failed. You are on the Free plan until it is fixed.`;
                const fix = 'Update your payment method in Google Play to restore it.';
                return {
                    event,
                    title: 'Your plan is on hold',
                    message: `${held} ${fix}`,
                    email: {
                        subject: `Your Findernate ${planName} plan is on hold`,
                        title: `Your ${planName} plan is on hold`,
                        preheader: 'The last payment failed.',
                        paragraphs: [held],
                        callout: fix
                    }
                };
            }
            if (reason === 'paused') {
                const paused = `Your ${planName} plan is paused in Google Play. You are on the Free plan until it resumes.`;
                const back = 'You can resume it any time in Google Play.';
                return {
                    event,
                    title: 'Your plan is paused',
                    message: `${paused} ${back}`,
                    email: {
                        subject: `Your Findernate ${planName} plan is paused`,
                        title: `Your ${planName} plan is paused`,
                        preheader: 'You are on the Free plan until it resumes.',
                        paragraphs: [paused],
                        callout: back
                    }
                };
            }
            return {
                event,
                title,
                message: `Your ${planName} plan has ended. You are on the Free plan now.`,
                email: {
                    subject: `Your Findernate ${planName} plan has ended`,
                    title: `Your ${planName} plan has ended`,
                    preheader: 'You are on the Free plan now.',
                    paragraphs: [`Your ${planName} plan has ended. You are on the Free plan now.`],
                    callout: 'You can subscribe again at any time from the Subscription page in the app or on findernate.com.'
                }
            };

        case 'plan_extended':
            return {
                event,
                title,
                message: date ? `Your ${planName} plan is extended until ${date}.` : `Your ${planName} plan is extended.`,
                email: null
            };

        default:
            return null;
    }
};
