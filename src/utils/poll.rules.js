/**
 * Polls on posts (Phase 6 #72), without any database or framework so they can
 * be unit tested. Story polls are a separate thing (see phase5.rules.js); this
 * is the poll a person attaches to a normal post, a product, a service or a vibe.
 *
 * A poll is saved with the post:      { question, options: [text], endsAt }
 * A vote is one row per person:       { postId, userId, choice }   (index into options)
 *
 * The rules, in one place:
 *   - 2 to 4 different answers, each up to 60 characters; a question up to 140.
 *   - It runs for 1 hour to 30 days (7 days when the author does not say).
 *   - One vote per person, and it cannot be changed or taken back.
 *   - The author cannot vote on their own poll.
 *   - The author, people who have voted and everybody once the poll has ended
 *     see the results; anyone else sees only the question and the answers, so
 *     the numbers cannot sway them.
 */

export class PollValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PollValidationError';
    }
}

export const POLL_LIMITS = Object.freeze({
    question: 140,
    option: 60,
    minOptions: 2,
    maxOptions: 4,
    minHours: 1,
    maxHours: 24 * 30,
    defaultHours: 24 * 7,
    maxBatch: 30,
});

const HOUR = 60 * 60 * 1000;

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The poll a request carries, as an object. Multipart forms send it as JSON text. */
export const parsePollInput = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            throw new PollValidationError('That poll could not be read.');
        }
    }
    return typeof value === 'object' ? value : null;
};

/**
 * Cleans the poll in a new post. Returns `undefined` when the request has no
 * poll, the poll to store when it is fine, or throws a PollValidationError with
 * something the author can act on.
 */
export const sanitizePoll = (raw, { now = new Date() } = {}) => {
    const input = parsePollInput(raw);
    if (!input) return undefined;

    const question = clean(input.question, POLL_LIMITS.question);
    if (!question) throw new PollValidationError('Write the question for your poll.');

    const list = Array.isArray(input.options) ? input.options : [];
    const options = [];
    const seen = new Set();
    for (const item of list) {
        const text = clean(typeof item === 'string' ? item : item?.text, POLL_LIMITS.option);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) throw new PollValidationError('Each answer has to be different.');
        seen.add(key);
        options.push(text);
    }
    if (options.length < POLL_LIMITS.minOptions) {
        throw new PollValidationError(`A poll needs at least ${POLL_LIMITS.minOptions} answers.`);
    }
    if (options.length > POLL_LIMITS.maxOptions) {
        throw new PollValidationError(`A poll can have up to ${POLL_LIMITS.maxOptions} answers.`);
    }

    let hours = POLL_LIMITS.defaultHours;
    if (input.durationHours !== undefined && input.durationHours !== null && input.durationHours !== '') {
        hours = Number(input.durationHours);
        if (!Number.isFinite(hours) || hours < POLL_LIMITS.minHours || hours > POLL_LIMITS.maxHours) {
            throw new PollValidationError('A poll can run from 1 hour up to 30 days.');
        }
    }
    return { question, options, endsAt: new Date(now.getTime() + hours * HOUR) };
};

export const pollHasEnded = (poll, now = new Date()) => {
    if (!poll?.endsAt) return false;
    const end = new Date(poll.endsAt).getTime();
    return Number.isFinite(end) && end <= now.getTime();
};

/** The index of the answer a vote picks. Throws when it is not one of the answers. */
export const readPollVote = (poll, body = {}) => {
    const choice = Number(body?.choice);
    if (body?.choice === undefined || body?.choice === null || body?.choice === '' || !Number.isInteger(choice)
        || choice < 0 || choice >= (poll?.options?.length || 0)) {
        throw new PollValidationError('Pick one of the answers.');
    }
    return choice;
};

/**
 * Counts per answer from a database $group result: one entry per answer,
 * { choice, n }. Popular posts can have thousands of votes, so the database
 * does the counting.
 */
export const statsFromGroups = (poll, groups = []) => {
    const counts = (poll?.options || []).map(() => 0);
    let total = 0;
    for (const g of groups) {
        const n = g?.n || 0;
        total += n;
        if (Number.isInteger(g?.choice) && counts[g.choice] !== undefined) counts[g.choice] += n;
    }
    return { total, counts };
};

/**
 * What a person sees about one poll.
 *
 * `stats` are the counts, `mine` is the viewer's own vote (the index, or null),
 * `isOwner` says the viewer wrote the post. Counts and percentages are left out
 * entirely, not zeroed, when the viewer may not see them yet.
 */
export const summarizePoll = (poll, stats, mine, { isOwner = false, now = new Date() } = {}) => {
    const ended = pollHasEnded(poll, now);
    const voted = Number.isInteger(mine);
    const canSeeResults = isOwner || voted || ended;
    const total = stats?.total || 0;
    const options = (poll?.options || []).map((text, index) => {
        const base = { index, text };
        if (!canSeeResults) return base;
        const votes = stats?.counts?.[index] || 0;
        return { ...base, votes, percent: total ? Math.round((votes / total) * 100) : 0 };
    });
    return {
        question: poll?.question || '',
        endsAt: poll?.endsAt ? new Date(poll.endsAt).toISOString() : null,
        ended,
        voted,
        myChoice: voted ? mine : null,
        canSeeResults,
        totalVotes: canSeeResults ? total : null,
        options,
    };
};
