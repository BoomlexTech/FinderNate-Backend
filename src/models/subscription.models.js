import mongoose from 'mongoose';

const SubscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
        unique: true // One active subscription per user (unless you support multiple)
    },
    plan: {
        type: String,
        required: true,
        enum: ['free', 'small_business', 'corporate'] // Only three tiers: free, small_business, and corporate
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'expired', 'cancelled'],
        default: 'active'
    },
    paymentId: {
        type: String,
        default: null // Link to external payment gateway transaction ID
    },
    /**
     * Every gateway payment/order id this subscription has ever been activated
     * with — the redemption history, not just the latest receipt.
     *
     * `paymentId` above holds one id and renewal overwrites it, so it cannot
     * answer "has this payment already been used?": the moment a second month
     * is paid, the first month's id is gone from the database entirely. A paid
     * Cashfree order stays order_status PAID forever, so the user could re-post
     * an old cashfreeOrderId for a free month, alternating old receipts
     * indefinitely. The replay guard has to look at the full history.
     */
    redeemedPaymentIds: {
        type: [String],
        default: [],
        index: true
    },
    autoRenew: {
        type: Boolean,
        default: true
    },
    /**
     * Which gateway the CURRENT period was bought through.
     *
     * Needed because the two gateways renew in opposite directions. Cashfree
     * renewals arrive as a fresh client-driven payment, so nothing happens
     * unless the user comes back and pays. Google Play renews on its own and
     * only tells us afterwards, via a Real-time Developer Notification — so a
     * google_play subscription must NOT be expired locally by the nightly job
     * just because endDate passed; Play may simply be in its grace period and
     * about to notify us. See jobs/subscriptionExpiry.job.js.
     *
     * Legacy rows predate the field and are Cashfree by definition; the default
     * reflects that rather than leaving them undefined.
     */
    source: {
        type: String,
        enum: ['cashfree', 'google_play'],
        default: 'cashfree',
        index: true
    },
    /**
     * Google Play's purchase token for the current subscription. This is the
     * handle for every later question about the subscription — it is what
     * purchases.subscriptionsv2.get takes, and what an RTDN carries. It stays
     * stable across automatic renewals of the same subscription and only
     * changes when the user re-subscribes after a lapse or upgrades tier.
     */
    playPurchaseToken: {
        type: String,
        default: null,
        index: true,
        sparse: true
    },
    /** The Play product id purchased, e.g. 'small_business' / 'corporate'. */
    playProductId: {
        type: String,
        default: null
    },
    /**
     * Play purchase tokens that used to be this user's current one and no longer
     * are, because they were replaced by an upgrade/downgrade, or because a
     * website (Cashfree) purchase took over the plan.
     *
     * The row holds ONE current token, so without this list a replaced token is
     * indistinguishable from a stranger: Play keeps sending notifications about
     * it (it expires, it is cancelled, or it is simply still alive), and each one
     * used to look like "the user's subscription changed". An old token that
     * reports ACTIVE flipped a Corporate payer back to Small Business; one that
     * reports EXPIRED could switch the new plan off. Anything found here is
     * ignored outright: it neither activates nor deactivates.
     *
     * Capped (see MAX_RETIRED_PLAY_TOKENS in activation.js), newest last.
     */
    retiredPlayTokens: {
        type: [String],
        default: [],
        index: true
    },
    /**
     * A plan change Play has already scheduled but that has not happened yet: the
     * user asked to downgrade (Corporate -> Small Business) and keeps the plan
     * they paid for until the period ends. Read from the purchase's
     * lineItems[0].deferredItemReplacement. `plan` stays the CURRENT plan until
     * the switch actually happens, so every entitlement check stays correct.
     * Cleared by any activation (the switch happened, or the user changed their
     * mind) and by a deactivation.
     */
    pendingPlan: {
        type: String,
        enum: ['small_business', 'corporate', null],
        default: null
    },
    /** When [pendingPlan] takes over — the end of the period already paid for. */
    pendingPlanAt: {
        type: Date,
        default: null
    },
    /**
     * Which plan notices (see controllers/subscription/notices.js) this user has
     * already been sent, as keys that name the thing the notice was about: the
     * payment an activation came from, the endDate a reminder counted down to,
     * the downgrade that was scheduled. Sending is "claim the key, then send":
     * the claim is one update that only matches while the key is absent, so the
     * Play notification, the app's verify call and the nightly job can all see the
     * same change and exactly one of them tells the user.
     *
     * Keys name their endDate, so a renewal (which moves endDate) starts a fresh
     * set of reminders without anything having to reset. Capped (see
     * MAX_SENT_NOTICES) so the row stays small; newest last. Written only with
     * atomic updates, never through save(), so it cannot cause a VersionError for
     * the billing writes. Internal bookkeeping: toPublicSubscription removes it.
     *
     * `default: undefined` on purpose. An array path defaults to [] otherwise, and
     * Mongoose then writes that [] ($set) the first time a row that predates this
     * field is save()d, which would wipe a claim another writer made a moment
     * earlier and let the same notice go out twice. Left undefined, a missing
     * field stays missing: the claim ($ne + $push) works on it, and readers use
     * `|| []`.
     */
    sentNotices: {
        type: [String],
        default: undefined
    }
}, { timestamps: true });

// Record the redemption without every caller having to remember to. The
// activation path (subscription/payment.js, Cashfree) assigns paymentId and
// then save(), so appending here keeps the history complete for renewals and
// first activations alike. This hook is the reason the guard still holds if a
// second activation path is ever added — it cannot forget to record.
//
// A legacy Razorpay webhook was a second writer here until the non-Cashfree
// gateways were removed; historical redeemedPaymentIds may therefore contain
// Razorpay payment ids (pay_*). They are kept: this array is the replay guard,
// and dropping an id would let it be redeemed again.
SubscriptionSchema.pre('save', function (next) {
    if (!Array.isArray(this.redeemedPaymentIds)) this.redeemedPaymentIds = [];

    if (this.isModified('paymentId') && this.paymentId) {
        const id = String(this.paymentId);
        if (!this.redeemedPaymentIds.includes(id)) {
            this.redeemedPaymentIds.push(id);
        }
    }
    next();
});

export default mongoose.model('Subscription', SubscriptionSchema);
