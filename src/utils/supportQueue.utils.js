/**
 * The rules behind the support queue, kept free of the database so they can be
 * tested on their own.
 *
 * Priority is decided on the server from the sender's plan at the moment they
 * write in. It is a promise about ORDER and about a reply target, both of which
 * need someone to actually answer the queue: the targets below are what the
 * admin page measures "Overdue" against, not something the code can deliver.
 */

export const FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved'];
export const FEEDBACK_PRIORITIES = ['standard', 'priority', 'dedicated'];

// The categories the website's feedback form offers. Matching against this list
// (rather than any "[text]" at the start of a message) keeps a user who happens
// to open with a bracket from having the start of their message eaten.
export const FEEDBACK_CATEGORIES = [
    'Bug Report',
    'Feature Request',
    'Content Issue',
    'Account Help',
    'General Feedback',
    'Other'
];

const PRIORITY_BY_TIER = {
    free: { priority: 'standard', priorityRank: 0 },
    small_business: { priority: 'priority', priorityRank: 1 },
    corporate: { priority: 'dedicated', priorityRank: 2 }
};

export const priorityForTier = (tier) => PRIORITY_BY_TIER[tier] || PRIORITY_BY_TIER.free;

// ---------------------------------------------------------------------------
// Reply targets
// ---------------------------------------------------------------------------
const DEFAULT_SLA_HOURS = { standard: 72, priority: 24, dedicated: 8 };
const SLA_ENV_NAMES = {
    standard: 'SUPPORT_SLA_HOURS_STANDARD',
    priority: 'SUPPORT_SLA_HOURS_PRIORITY',
    dedicated: 'SUPPORT_SLA_HOURS_DEDICATED'
};

export const getSlaHours = (priority, env = process.env) => {
    const parsed = Number.parseInt(env[SLA_ENV_NAMES[priority]], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    return DEFAULT_SLA_HOURS[priority] ?? DEFAULT_SLA_HOURS.standard;
};

// Support hours as published on the contact page, in IST: Mon-Fri 9-6, Sat 10-4,
// closed Sunday. Keys are getUTCDay() of the IST wall clock (0 = Sunday).
const IST_OFFSET_MS = 330 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SUPPORT_HOURS_IST = { 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [10, 16] };

export const isSupportOpen = (date) => {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const hours = SUPPORT_HOURS_IST[ist.getUTCDay()];
    if (!hours) return false;
    const hourOfDay = ist.getUTCHours() + ist.getUTCMinutes() / 60;
    return hourOfDay >= hours[0] && hourOfDay < hours[1];
};

/** `date` itself when support is open, otherwise the next moment it opens. */
export const nextSupportOpening = (date) => {
    if (isSupportOpen(date)) return new Date(date);

    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + dayOffset));
        const hours = SUPPORT_HOURS_IST[day.getUTCDay()];
        if (!hours) continue;
        const opening = new Date(day.getTime() + hours[0] * HOUR_MS - IST_OFFSET_MS);
        if (opening > date) return opening;
    }
    return new Date(date);
};

/**
 * When a request should have its first reply by.
 *
 * The target is the plan's number of hours after the request arrives, and a
 * target that would land while support is closed moves to the next opening, so
 * "24 hours" sent on a Friday evening reads Monday morning, not Saturday night.
 */
export const computeSlaDueAt = (priority, from = new Date(), env = process.env) =>
    nextSupportOpening(new Date(from.getTime() + getSlaHours(priority, env) * HOUR_MS));

export const isFeedbackOverdue = (feedback, now = new Date()) =>
    feedback.status !== 'resolved'
    && !feedback.firstResponseAt
    && !!feedback.slaDueAt
    && now > new Date(feedback.slaDueAt);

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

/**
 * What to write when an admin moves a request to `nextStatus`.
 *
 * A row with no status is a pre-queue legacy row and counts as resolved, the
 * same way the list treats it. The first reply is stamped once, on the first
 * move off 'open'; reopening a resolved request clears resolvedAt but keeps the
 * original first-reply time.
 */
export const buildStatusChange = (current, nextStatus, now = new Date()) => {
    const currentStatus = current.status || 'resolved';
    const set = { status: nextStatus };
    const unset = {};

    if (currentStatus === 'open' && nextStatus !== 'open' && !current.firstResponseAt) {
        set.firstResponseAt = now;
    }

    if (nextStatus === 'resolved') {
        if (currentStatus !== 'resolved') set.resolvedAt = now;
    } else if (current.resolvedAt) {
        unset.resolvedAt = '';
    }

    return { set, unset };
};

/**
 * Query fragment for a status tab. No status means the working queue (open and
 * in progress). Legacy rows without a status read as resolved, so they stay
 * visible whether or not the backfill has been run.
 */
export const statusQuery = (status) => {
    if (status === 'resolved') {
        return { $or: [{ status: 'resolved' }, { status: { $exists: false } }] };
    }
    if (status === 'open' || status === 'in_progress') return { status };
    return { status: { $in: ['open', 'in_progress'] } };
};

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------
const CATEGORY_PREFIX = /^\[([^\]\r\n]{1,40})\]\s+/;

/**
 * The website's feedback form sends its category as a "[Category] " prefix on
 * the message. Split a known one off so the admin page can show it as a chip.
 */
export const splitCategoryPrefix = (message) => {
    const match = CATEGORY_PREFIX.exec(message);
    if (!match) return { category: undefined, message };

    const category = match[1].trim();
    const rest = message.slice(match[0].length).trim();
    if (!FEEDBACK_CATEGORIES.includes(category) || !rest) return { category: undefined, message };

    return { category, message: rest };
};
