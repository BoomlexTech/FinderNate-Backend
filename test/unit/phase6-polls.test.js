import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POLL_LIMITS, PollValidationError, parsePollInput, sanitizePoll, pollHasEnded,
    readPollVote, statsFromGroups, summarizePoll,
} from '../../src/utils/poll.rules.js';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const HOUR = 3600 * 1000;

const poll = (extra = {}) => ({
    question: 'Tea or coffee?',
    options: ['Tea', 'Coffee', 'Neither'],
    endsAt: new Date(NOW.getTime() + 24 * HOUR),
    ...extra,
});

const refuses = (fn, pattern) => assert.throws(fn, (e) => e instanceof PollValidationError && pattern.test(e.message));

// ── creating a poll ─────────────────────────────────────────────────────────

test('#72 a request with no poll has no poll', () => {
    for (const v of [undefined, null, '']) assert.equal(sanitizePoll(v, { now: NOW }), undefined);
});

test('#72 a poll runs 7 days unless the author says otherwise', () => {
    const p = sanitizePoll({ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] }, { now: NOW });
    assert.equal(p.question, 'Tea or coffee?');
    assert.deepEqual(p.options, ['Tea', 'Coffee']);
    assert.equal(p.endsAt.getTime(), NOW.getTime() + 7 * 24 * HOUR);
});

test('#72 the author can choose from 1 hour to 30 days', () => {
    const one = sanitizePoll({ question: 'Q', options: ['a', 'b'], durationHours: 1 }, { now: NOW });
    assert.equal(one.endsAt.getTime(), NOW.getTime() + HOUR);
    const month = sanitizePoll({ question: 'Q', options: ['a', 'b'], durationHours: '720' }, { now: NOW });
    assert.equal(month.endsAt.getTime(), NOW.getTime() + 720 * HOUR);
    for (const bad of [0, 0.5, 721, -3, 'soon', NaN]) {
        refuses(() => sanitizePoll({ question: 'Q', options: ['a', 'b'], durationHours: bad }, { now: NOW }), /1 hour up to 30 days/);
    }
});

test('#72 a poll that came as JSON text (a multipart form) is read the same way', () => {
    const text = JSON.stringify({ question: ' Best  day? ', options: ['Sat', { text: 'Sun' }], durationHours: 24 });
    const p = sanitizePoll(text, { now: NOW });
    assert.equal(p.question, 'Best day?');
    assert.deepEqual(p.options, ['Sat', 'Sun']);
    assert.equal(p.endsAt.getTime(), NOW.getTime() + 24 * HOUR);
    refuses(() => sanitizePoll('{not json', { now: NOW }), /could not be read/);
    assert.equal(parsePollInput('"just text"'), null);
});

test('#72 the question and every answer are required, trimmed and cut to length', () => {
    refuses(() => sanitizePoll({ question: '   ', options: ['a', 'b'] }, { now: NOW }), /question/);
    refuses(() => sanitizePoll({ options: ['a', 'b'] }, { now: NOW }), /question/);
    const long = sanitizePoll({ question: 'q'.repeat(300), options: ['x'.repeat(200), 'y'] }, { now: NOW });
    assert.equal(long.question.length, POLL_LIMITS.question);
    assert.equal(long.options[0].length, POLL_LIMITS.option);
    // Blank answers are ignored rather than counted.
    const blanks = sanitizePoll({ question: 'Q', options: ['a', '  ', '', 'b', null] }, { now: NOW });
    assert.deepEqual(blanks.options, ['a', 'b']);
});

test('#72 a poll has 2 to 4 different answers', () => {
    refuses(() => sanitizePoll({ question: 'Q', options: ['only one'] }, { now: NOW }), /at least 2/);
    refuses(() => sanitizePoll({ question: 'Q', options: [] }, { now: NOW }), /at least 2/);
    refuses(() => sanitizePoll({ question: 'Q' }, { now: NOW }), /at least 2/);
    refuses(() => sanitizePoll({ question: 'Q', options: ['a', 'b', 'c', 'd', 'e'] }, { now: NOW }), /up to 4/);
    refuses(() => sanitizePoll({ question: 'Q', options: ['Yes', 'yes '] }, { now: NOW }), /different/);
    assert.equal(sanitizePoll({ question: 'Q', options: ['a', 'b', 'c', 'd'] }, { now: NOW }).options.length, 4);
});

// ── voting ──────────────────────────────────────────────────────────────────

test('#72 a vote is the number of one of the answers', () => {
    const p = poll();
    assert.equal(readPollVote(p, { choice: 0 }), 0);
    assert.equal(readPollVote(p, { choice: '2' }), 2);
    for (const bad of [{}, { choice: null }, { choice: '' }, { choice: -1 }, { choice: 3 }, { choice: 1.5 }, { choice: 'Tea' }, undefined]) {
        refuses(() => readPollVote(p, bad), /Pick one of the answers/);
    }
});

test('#72 a poll ends at its end time and not before', () => {
    assert.equal(pollHasEnded(poll(), NOW), false);
    assert.equal(pollHasEnded(poll({ endsAt: NOW }), NOW), true);
    assert.equal(pollHasEnded(poll({ endsAt: new Date(NOW.getTime() - 1) }), NOW), true);
    assert.equal(pollHasEnded(poll({ endsAt: new Date(NOW.getTime() + 1) }), NOW), false);
    assert.equal(pollHasEnded(null, NOW), false);
    assert.equal(pollHasEnded({ endsAt: 'garbage' }, NOW), false);
});

// ── counting and who sees what ──────────────────────────────────────────────

test('#72 counts from database groups line up with the answers', () => {
    const p = poll();
    assert.deepEqual(statsFromGroups(p, []), { total: 0, counts: [0, 0, 0] });
    const stats = statsFromGroups(p, [{ choice: 0, n: 6 }, { choice: 2, n: 2 }, { choice: 9, n: 40 }, { choice: null, n: 3 }]);
    // Votes for an answer that does not exist are not counted as an answer, but they are still votes cast.
    assert.deepEqual(stats.counts, [6, 0, 2]);
    assert.equal(stats.total, 51);
});

test('#72 results stay hidden until you vote, except for the author and once the poll has ended', () => {
    const p = poll();
    const stats = { total: 4, counts: [3, 1, 0] };

    const stranger = summarizePoll(p, stats, null, { isOwner: false, now: NOW });
    assert.equal(stranger.canSeeResults, false);
    assert.equal(stranger.totalVotes, null);
    assert.equal(stranger.voted, false);
    assert.equal(stranger.myChoice, null);
    assert.deepEqual(stranger.options, [{ index: 0, text: 'Tea' }, { index: 1, text: 'Coffee' }, { index: 2, text: 'Neither' }]);
    for (const o of stranger.options) assert.ok(!('votes' in o) && !('percent' in o), 'no numbers for someone who has not voted');

    const voter = summarizePoll(p, stats, 1, { isOwner: false, now: NOW });
    assert.equal(voter.canSeeResults, true);
    assert.equal(voter.myChoice, 1);
    assert.equal(voter.totalVotes, 4);
    assert.deepEqual(voter.options.map((o) => o.votes), [3, 1, 0]);
    assert.deepEqual(voter.options.map((o) => o.percent), [75, 25, 0]);

    const owner = summarizePoll(p, stats, null, { isOwner: true, now: NOW });
    assert.equal(owner.canSeeResults, true);
    assert.equal(owner.voted, false);
    assert.equal(owner.totalVotes, 4);

    const later = new Date(NOW.getTime() + 25 * HOUR);
    const after = summarizePoll(p, stats, null, { isOwner: false, now: later });
    assert.equal(after.ended, true);
    assert.equal(after.canSeeResults, true);
    assert.equal(after.totalVotes, 4);
});

test('#72 vote number 0 counts as having voted', () => {
    const s = summarizePoll(poll(), { total: 1, counts: [1, 0, 0] }, 0, { now: NOW });
    assert.equal(s.voted, true);
    assert.equal(s.myChoice, 0);
    assert.equal(s.canSeeResults, true);
});

test('#72 an empty poll shows zeros, not a division error', () => {
    const s = summarizePoll(poll(), { total: 0, counts: [0, 0, 0] }, null, { isOwner: true, now: NOW });
    assert.deepEqual(s.options.map((o) => o.percent), [0, 0, 0]);
    assert.equal(s.totalVotes, 0);
});

test('#72 the end time is sent as an ISO date', () => {
    const s = summarizePoll(poll(), { total: 0, counts: [0, 0, 0] }, null, { now: NOW });
    assert.equal(s.endsAt, new Date(NOW.getTime() + 24 * HOUR).toISOString());
    assert.equal(s.question, 'Tea or coffee?');
});
