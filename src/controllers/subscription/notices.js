import Subscription from '../../models/subscription.models.js';

// ─────────────────────────────────────────────────────────────────────────────
// Telling a business what is happening to its plan — exactly once, and never at
// billing's expense.
//
// The facts come from three places that routinely see the SAME change: Google
// Play's notification, the app's verify call, and the nightly job (for a website
// payment, the success-page verify call and Cashfree's webhook). Each of them
// reaches the code that changes the plan, so that code is where a notice is
// raised (persistActivation, persistDeactivation, refreshPlayFacts, the expiry
// job); this file decides what is owed and sends it.
//
// Two rules, both learned from billing code that already lives here:
//
//  · One notice per change. Detecting the change in the writer is not enough on
//    its own: two writers that both loaded the row before either saved BOTH see
//    "plan was Small Business, is now Corporate" (a save of plain fields carries
//    no version check, as the retirePlayToken note in activation.js explains).
//    So a notice is claimed first, with one atomic update that only matches
//    while its key is absent from the row, and only the writer that wins the
//    claim sends. The key names what the notice is about (see KEYS), so a
//    legitimate second change gets a different key.
//
//  · A notice can never hurt billing. Everything here runs detached from the
//    caller, swallows its own errors, and is only ever awaited by the nightly
//    job, which has no customer waiting on it. If sending fails the claim is
//    given back so a later attempt (the job's re-run) can try again.
// ─────────────────────────────────────────────────────────────────────────────

/** The most notice keys a row remembers; the oldest are dropped first. */
export const MAX_SENT_NOTICES = 30;

const instant = (date) => (date ? new Date(date).getTime() : null);

// What each notice is about. Anything two writers might both report must produce
// the same key for the same change and a different key for the next one.
const paymentKey = (subscription) =>
    subscription.paymentId || `${subscription.plan}:${instant(subscription.endDate)}`;

const KEYS = {
    // One activation per payment: the redemption guard sees to that, so a
    // payment id names exactly one "you are now on…" / "extended until…". The key
    // deliberately does NOT name the event. Two writers of the same payment can
    // disagree on it: the second one loads the row after the first has saved, sees
    // the user already on that plan, and computes "extended" where the first said
    // "now on". With the event in the key those are two claims and the user is
    // told twice; without it, whichever claims first speaks for the payment.
    activation: (subscription) => `activation:${paymentKey(subscription)}`,
    // The end of one period of one plan. Its endDate moves when the plan is
    // renewed or replaced, so the next period starts a fresh set of reminders.
    endingSoon: (endDate, daysLeft) => `ending_soon:${instant(endDate)}:${daysLeft}`,
    // Within one receipt a user can switch renewal off, on and off again; the
    // restart gives the key back (see announceFactChanges) so the second cancel
    // is announced too.
    renewalCancelled: (subscription) => `renewal_cancelled:${paymentKey(subscription)}`,
    downgrade: (subscription, pendingPlan, pendingPlanAt) =>
        `downgrade_scheduled:${paymentKey(subscription)}:${pendingPlan}:${instant(pendingPlanAt)}`,
    planEnded: (subscription) => `plan_ended:${paymentKey(subscription)}:${instant(subscription.endDate)}`
};

// ── plumbing ─────────────────────────────────────────────────────────────────

const inFlight = new Set();

const track = (promise) => {
    inFlight.add(promise);
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
};

/**
 * Resolves once every notice that has been started has finished. For tests and
 * for a graceful shutdown; nothing in the request path should wait on it.
 */
export const whenNoticesSettled = async () => {
    while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
    }
};

/**
 * Takes [key] for this row if it is not already taken. True when this caller got
 * it. [guard] adds conditions the row must still meet at the moment of the claim
 * (the reminder job uses it so a renewal that landed after the row was read
 * cannot still be reminded about).
 *
 * timestamps:false because this is bookkeeping, not a change to the plan: it
 * must not move `updatedAt`.
 */
const claimNotice = async (subscriptionId, key, guard = {}) => {
    const result = await Subscription.updateOne(
        { ...guard, _id: subscriptionId, sentNotices: { $ne: key } },
        { $push: { sentNotices: { $each: [key], $slice: -MAX_SENT_NOTICES } } },
        { timestamps: false }
    );
    return Number(result?.modifiedCount ?? 0) === 1;
};

const releaseNotice = (subscriptionId, key) =>
    Subscription.updateOne(
        { _id: subscriptionId },
        { $pull: { sentNotices: key } },
        { timestamps: false }
    );

/**
 * Claims [key] and, if it is ours, sends the notice. Never rejects.
 *
 * Resolves to one of:
 *   'sent'      the notice was created (push and email are best-effort after that)
 *   'unclaimed' somebody already sent it, or the guard no longer holds
 *   'skipped'   nobody to tell (the account is gone); the claim is kept
 *   'failed'    something threw; the claim was given back so a retry can send it
 */
const dispatch = ({ userId, subscriptionId, key, event, details, guard }) => track((async () => {
    let claimed = false;
    try {
        claimed = await claimNotice(subscriptionId, key, guard);
        if (!claimed) return 'unclaimed';

        // Loaded on demand: the notification stack pulls in sockets, push and
        // mail, and billing should neither pay for that at start-up nor fail to
        // start because of it.
        const { createSubscriptionNotification } = await import('../notification.controllers.js');
        const notification = await createSubscriptionNotification({ recipientId: userId, event, ...details });
        return notification ? 'sent' : 'skipped';
    } catch (error) {
        console.warn(`[subscription-notice] ${event} for user ${userId} not sent: ${error?.message || error}`);
        if (claimed) {
            try {
                await releaseNotice(subscriptionId, key);
            } catch (releaseError) {
                console.warn(`[subscription-notice] could not give back ${event} for user ${userId}: ${releaseError?.message || releaseError}`);
            }
        }
        return 'failed';
    }
})());

const release = (subscription, key) => track((async () => {
    try {
        await releaseNotice(subscription._id, key);
    } catch (error) {
        console.warn(`[subscription-notice] could not reopen ${key} for user ${subscription.userId}: ${error?.message || error}`);
    }
})());

// ── what a change owes the user ──────────────────────────────────────────────

/**
 * Which notices does an activation owe? Pure.
 *
 * [subscription] is the row after the write, [before] what it was just before:
 * { plan, status, entitledPlan, token, pendingPlan, pendingPlanAt }, where
 * entitledPlan is the plan the user was really entitled to (null if none).
 *
 *  · Google Play. Play tells its own subscribers about their purchases and
 *    renewals, so a notice is only raised when the user's PLAN changed: a first
 *    purchase, an upgrade, a switch, a downgrade that has taken effect, or
 *    coming back after the plan ended. The same token being paid for another
 *    month is a renewal, and a renewal that arrives late (the plan was past its
 *    endDate in a grace period but the row was still active) is too.
 *  · Website (Cashfree). One paid month with no renewal, and nobody else will
 *    say anything: paying for the plan the user is already on is "extended",
 *    anything else is "now on".
 *
 * A downgrade scheduled in the same breath (a purchase first seen after the user
 * had already asked for it) is announced as well.
 */
export const activationEvents = (subscription, before) => {
    const events = [];

    if (subscription.source === 'google_play') {
        const renewal =
            before.status === 'active' &&
            before.plan === subscription.plan &&
            Boolean(before.token) &&
            before.token === subscription.playPurchaseToken;
        if (!renewal && before.entitledPlan !== subscription.plan) events.push('plan_changed');
    } else {
        events.push(before.entitledPlan === subscription.plan ? 'plan_extended' : 'plan_changed');
    }

    if (
        subscription.pendingPlan &&
        (subscription.pendingPlan !== before.pendingPlan ||
            instant(subscription.pendingPlanAt) !== instant(before.pendingPlanAt))
    ) {
        events.push('downgrade_scheduled');
    }
    return events;
};

const downgradeDetails = (subscription) => ({
    plan: subscription.plan,
    pendingPlan: subscription.pendingPlan,
    // The switch happens when the period already paid for ends.
    endDate: subscription.pendingPlanAt || subscription.endDate
});

/**
 * Raise the notices an activation owes (see activationEvents). Called by
 * persistActivation after the row is written; fire-and-forget by design.
 */
export const announceActivation = (subscription, before) => {
    try {
        for (const event of activationEvents(subscription, before)) {
            if (event === 'downgrade_scheduled') {
                dispatch({
                    userId: subscription.userId,
                    subscriptionId: subscription._id,
                    event,
                    key: KEYS.downgrade(subscription, subscription.pendingPlan, subscription.pendingPlanAt),
                    details: downgradeDetails(subscription)
                });
            } else {
                dispatch({
                    userId: subscription.userId,
                    subscriptionId: subscription._id,
                    event,
                    key: KEYS.activation(subscription),
                    details: { plan: subscription.plan, endDate: subscription.endDate }
                });
            }
        }
    } catch (error) {
        console.warn(`[subscription-notice] activation notice skipped for user ${subscription?.userId}: ${error?.message || error}`);
    }
};

/**
 * An ended plan can be bought again under the SAME order id (Play reporting a
 * token that was ended too early, or a payment on hold, live again). Its "you are
 * now on…" key is still on the row from the first time, so it would be swallowed;
 * the writer that ends the plan gives the key back so the second coming is news.
 * Called by persistDeactivation. Detached and best-effort like everything here.
 */
export const reopenActivationNotice = (subscription) => {
    try {
        release(subscription, KEYS.activation(subscription));
    } catch (error) {
        console.warn(`[subscription-notice] could not reopen the activation notice for user ${subscription?.userId}: ${error?.message || error}`);
    }
};

/**
 * Raise what a refresh of Play's facts on an already-active row owes the user.
 * [before] is { autoRenew, pendingPlan, pendingPlanAt } as they were before the
 * refresh, [subscription] the row after it. Called by refreshPlayFacts, which is
 * where Play switching renewal off (or scheduling a downgrade) lands, whichever
 * of the notification, the verify call or the sync endpoint saw it first.
 *
 * [cancelled] is whether Play reports the subscription as CANCELED. "Will not
 * renew" is only said then: autoRenew going false is read from an optional part
 * of Play's answer (`autoRenewingPlan`), and a read that merely lacks it must not
 * send a user an email telling them they cancelled.
 */
export const announceFactChanges = (subscription, before, { cancelled }) => {
    try {
        if (subscription.source !== 'google_play' || subscription.status !== 'active') return;

        if (before.autoRenew === true && subscription.autoRenew === false) {
            if (cancelled) {
                dispatch({
                    userId: subscription.userId,
                    subscriptionId: subscription._id,
                    event: 'renewal_cancelled',
                    key: KEYS.renewalCancelled(subscription),
                    details: { plan: subscription.plan, endDate: subscription.endDate }
                });
            }
        } else if (before.autoRenew === false && subscription.autoRenew === true) {
            // Renewal is back on, so a later cancel is news again.
            release(subscription, KEYS.renewalCancelled(subscription));
        }

        const pendingChanged =
            (before.pendingPlan || null) !== (subscription.pendingPlan || null) ||
            instant(before.pendingPlanAt) !== instant(subscription.pendingPlanAt);
        if (pendingChanged) {
            if (before.pendingPlan) {
                // The old schedule is gone (cleared or replaced); scheduling it again later is news.
                release(subscription, KEYS.downgrade(subscription, before.pendingPlan, before.pendingPlanAt));
            }
            if (subscription.pendingPlan) {
                dispatch({
                    userId: subscription.userId,
                    subscriptionId: subscription._id,
                    event: 'downgrade_scheduled',
                    key: KEYS.downgrade(subscription, subscription.pendingPlan, subscription.pendingPlanAt),
                    details: downgradeDetails(subscription)
                });
            }
        }
    } catch (error) {
        console.warn(`[subscription-notice] plan-change notice skipped for user ${subscription?.userId}: ${error?.message || error}`);
    }
};

/**
 * A plan that ended longer ago than this is not news. It happens when the nightly
 * job was down for a while, or for an old row nobody ever expired (the first run
 * after this shipped); telling those users now would be a burst of notices about
 * something they stopped having long ago.
 */
const STALE_ENDING_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Tell the user their plan has ended. [subscription] is the row as it was just
 * ended (its plan and endDate are what the notice names). Fire-and-forget; the
 * returned promise only exists for callers that want the outcome.
 *
 * [reason] is 'on_hold' or 'paused' when Google Play ended the plan for one of
 * those (see ENDED_STATES in googlePlay.js); the wording then says so instead of
 * claiming the plan ran out. Omit it for a plan that simply ended.
 */
export const announcePlanEnded = (subscription, reason) => {
    try {
        if (instant(subscription.endDate) < Date.now() - STALE_ENDING_MS) return Promise.resolve('skipped');
        return dispatch({
            userId: subscription.userId,
            subscriptionId: subscription._id,
            event: 'plan_ended',
            key: KEYS.planEnded(subscription),
            details: { plan: subscription.plan, endDate: subscription.endDate, reason }
        });
    } catch (error) {
        console.warn(`[subscription-notice] plan-ended notice skipped for user ${subscription?.userId}: ${error?.message || error}`);
        return Promise.resolve('failed');
    }
};

/**
 * One "your plan ends soon" reminder, [daysLeft] calendar days before the end.
 * Resolves to dispatch's outcome. The guard keeps a stale read from sending: it
 * only goes out while the row is still active, still ends on the date it was read
 * with, and still will not renew (a legacy row has no `source`, which is why this
 * excludes Play-and-renewing rather than requiring `cashfree`).
 */
export const announceEndingSoon = (subscription, daysLeft) =>
    dispatch({
        userId: subscription.userId,
        subscriptionId: subscription._id,
        event: 'ending_soon',
        key: KEYS.endingSoon(subscription.endDate, daysLeft),
        guard: {
            status: 'active',
            endDate: subscription.endDate,
            $nor: [{ source: 'google_play', autoRenew: true }]
        },
        details: {
            plan: subscription.plan,
            endDate: subscription.endDate,
            source: subscription.source,
            daysLeft
        }
    });
