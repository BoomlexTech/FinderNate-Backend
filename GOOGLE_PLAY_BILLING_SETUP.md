# Google Play Billing — setup

What has to exist outside the codebase before an in-app subscription can be
bought. The code is done; everything below is console work.

Play app: **Findernate**, package `com.findernate.app`, app ID
`4972555896537488250`, under developer account **Findernate Ecom Private
Limited** (`7987434650123861211`).

---

## Why the order matters

These steps genuinely cannot be reordered:

1. **A build containing the billing library must be uploaded first.** Until an
   AAB with the Play Billing Library reaches a track, Play Console's
   Subscriptions page just says *"Upload a new APK"* and will not let you create
   a product. That build exists now — `in_app_purchase` pulls the library in.
2. **A payments profile must exist before products can be priced.**
3. **Products must exist before the app can query them** — otherwise
   `queryProductDetails` returns them in `notFoundIDs` and the plans screen
   shows no Play prices.
4. **The service account must be linked before the server can verify anything.**

---

## 1. Payments profile  *(only the account owner can do this)*

Play Console → **Monetise with Play** → **Get started**.

Needs Findernate Ecom Private Limited's legal details, tax info (PAN/GST) and a
bank account. Nothing can be sold until this is complete and verified, which
can take a few days.

## 2. Upload the AAB to Internal testing

Play Console → **Test and release** → **Testing** → **Internal testing** →
**Create new release**, and upload
`build/app/outputs/bundle/release/app-release.aab`.

Add yourself to the tester list. This is also the first build on which the
Cashfree store flow can be tested properly — Cashfree's production SDK rejects
sideloaded installs, which is why it never worked from a local APK.

## 3. Create the subscription products

Play Console → **Monetise with Play** → **Products** → **Subscriptions**.

Create two, with product IDs matching `PLAY_PRODUCT_TO_PLAN` in
`src/controllers/subscription/plans.js` exactly — **product IDs are permanent**:

| Product ID       | Name           | Base plan ID | Billing period | Price      |
|------------------|----------------|--------------|----------------|------------|
| `small_business` | Small Business | `monthly`    | Monthly        | ₹19        |
| `corporate`      | Corporate      | `monthly`    | Monthly        | ₹999       |

Set each base plan to **auto-renewing** and activate it — a base plan left as a
draft is invisible to the app.

The prices above are the owner's decision and match `SUBSCRIPTION_PLANS` in
`plans.js`. Set them in Play Console to the same figures before enabling
purchase, and check Play's minimum price for INR subscriptions when saving (not
verified here). Play makes price changes for existing subscribers slow and
consent-gated, so get the number right before the first real subscriber.

Note the backend's `SUBSCRIPTION_PLANS` prices are only used for display and
for the Cashfree (web) path. On Android, Play's price is authoritative and is
what the user is actually charged — the plans screen shows Play's localised
string, not ours.

What each plan includes is **not** listed here: the single source is
`buildPlanCatalog()` in `plans.js` (served by `GET /subscription/plans`), and the
Play listing text in the app repo's `PLAY_STORE_SUBMISSION.md` is written from
it. Keep the Play Console listing in step with that list, with no prices in the
text (Play shows the localised price itself).

## 4. Service account for the Developer API

The server has to ask Google what a purchase token means. That needs a Google
Cloud service account with access to the Play developer account.

1. **Google Cloud Console** → pick or create a project → **APIs & Services** →
   enable **Google Play Android Developer API**.
2. **IAM & Admin → Service Accounts** → create one, e.g.
   `findernate-play-billing`. No project roles are required.
3. On that service account → **Keys** → **Add key** → **JSON**. Download it.
   *This file is a credential — it must not go into the repo.*
4. **Play Console → Setup → API access** → link the Google Cloud project from
   step 1, find the service account, **Grant access**, and give it:
   - View financial data, orders, and cancellation survey responses
   - Manage orders and subscriptions

   Restrict it to the Findernate app rather than the whole account.

> The linkage in step 4 is the one people miss. Without it every call fails with
> *"The current user has insufficient permissions"*, which reads like an OAuth
> scope problem and is not — the scope is fine, the service account simply is
> not known to the Play account.

> Access can take up to 24 hours to propagate. A 401 immediately after granting
> is usually just that.

## 5. Real-time Developer Notifications

Without this, renewals never reach us: Play charges the card by itself and only
announces it here. A subscriber's `endDate` would lapse a month after purchase.

1. **Google Cloud → Pub/Sub → Topics** → create e.g. `play-rtdn`.
2. Grant `google-play-developer-notifications@system.gserviceaccount.com` the
   **Pub/Sub Publisher** role on that topic. (Play cannot publish without it.)
3. **Play Console → Monetise with Play → Monetisation setup** → paste the full
   topic name, then **Send test notification** to confirm.
4. Back in Pub/Sub, create a **push** subscription on the topic with endpoint:

   ```
   https://apis.findernate.com/api/v1/subscription/google-play/notification?token=<GOOGLE_PLAY_RTDN_SECRET>
   ```

   The `?token=` shared secret is the only authentication on that route — it is
   public because Pub/Sub has no user session. Generate something long and
   random and keep it out of the repo.

## 6. Licence testers (test purchases without being charged)

Play Console → **Setup → Licence testing** → add the Google accounts that should
get test purchases. Their purchases are free and renew on an accelerated clock
(a monthly subscription renews every ~5 minutes), which is the only practical
way to exercise the renewal and RTDN paths.

Testers must also be on the Internal testing track and must install the app
**from Play**, not by sideloading.

---

## Environment variables

Add to the backend environment (and to whatever secret store production uses):

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | yes* | The service-account JSON from step 3. Raw JSON, or base64 of it — base64 is safer in `.env` files, which mangle the newlines inside `private_key`. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE` | yes* | Alternative to the above: a path to the JSON on disk. |
| `GOOGLE_PLAY_PACKAGE_NAME` | no | Defaults to `com.findernate.app`. |
| `GOOGLE_PLAY_RTDN_SECRET` | yes | Shared secret in the Pub/Sub push URL. Without it the notification route rejects everything with 403. |

\* one of the two.

To base64 the key file:

```bash
base64 -w0 findernate-play-billing.json
```

---

## What the code does

| Piece | File |
|---|---|
| Play API client (lookup + acknowledge) | `src/config/googlePlay.config.js` |
| Verify endpoint + RTDN handler + reconcile | `src/controllers/subscription/googlePlay.js` |
| Activation logic shared with Cashfree | `src/controllers/subscription/activation.js` |
| Product ID ↔ plan tier map | `src/controllers/subscription/plans.js` |
| Routes | `src/routes/subscription.routes.js` |
| App-side billing | `lib/services/google_play_billing.dart` (Flutter repo) |

Endpoints:

- `POST /api/v1/subscription/google-play/verify` — authenticated, takes
  `{ purchaseToken }` only. The plan, price and buyer all come from Google's
  answer, never from the request body.
- `POST /api/v1/subscription/google-play/notification` — public, Pub/Sub push,
  authenticated by `?token=`.
- `POST /api/v1/subscription/google-play/sync` — authenticated, no body. Re-reads
  the caller's current Play subscription from Play and updates the row. Returns
  `{ success: true, data: { reconciled: boolean } }` and never a token. Limited
  to 6 calls a minute per user, because each one is a request to Google.

Cashfree is untouched and still handles the website's subscriptions and the
physical-goods store on every platform. Play Billing is not permitted for
physical goods, so the store must stay on Cashfree.

---

## Testing checklist

- [ ] Test notification from Monetisation setup arrives (look for
      `[Play RTDN] Test notification received`)
- [ ] Plans screen shows Play's localised prices, not the backend's
- [ ] Buying as a licence tester activates the plan and grants calling
- [ ] Killing the app between paying and verifying still activates on next
      launch (this is the `restorePurchases()` path)
- [ ] Verifying the same token twice succeeds rather than erroring
- [ ] A renewal (~5 min on a test account) extends `endDate` via RTDN
- [ ] Cancelling keeps access until `endDate`, then revokes it
- [ ] A non-business account is refused *before* Play's payment sheet opens

---

## Plan changes (upgrade, downgrade, cancel)

A user has ONE `Subscription` row. A plan change is a new Play purchase with a
new purchase token, so the row follows a chain of tokens. The row holds the
current token (`playPurchaseToken`) and remembers the ones it moved away from
(`retiredPlayTokens`); anything Play later says about a retired token is
ignored, so an old plan can neither flip the row back nor switch the new one off.

| What the user does | What Play does | What the backend does |
|---|---|---|
| Upgrade Small Business → Corporate (app, `chargeProratedPrice`) | New token T2 with `linkedPurchaseToken` = T1; T1 ends | `verify(T2)` or the T2 notification takes over: plan, token, end date change, T1 is retired |
| Downgrade Corporate → Small Business (app, `deferred`) | T1 stays until the period ends and now lists `lineItems[0].deferredItemReplacement` | `POST /sync` stores `pendingPlan` / `pendingPlanAt`; the plan stays Corporate. At renewal Play creates T2 (linked to T1) and its notification switches the plan with the app closed |
| Downgrade to Free (user cancels in Play) | T1 becomes `CANCELED`, paid until `expiryTime`, then `EXPIRED` | `autoRenew` false and `renewal.endsWithoutRenewal` true until the end date, then the row is ended and the business drops to Free |
| Buys on the website while a Play plan renews | – | `create-order` answers 409 (a renewing Play plan would keep billing and flip the plan back) |
| Buys on the website after cancelling renewal in Play | – | Allowed; the Cashfree plan takes over and the Play token is retired |

**Where an incoming Play token goes** (`activateForPlayPurchase`, in this order):
the row's own token (refresh; a renewal re-activates) → a token whose
`linkedPurchaseToken` is the row's token (replacement: takes over, old token
retired) → a retired token that Play reports dead (ignored, not acknowledged) →
any other token while the row is a Play plan that **Play says** still renews
(409, **not acknowledged**, so Play refunds it after 3 days) → anything else
(accepted, old Play token retired).

Three details of that order matter:

- The 409 is decided with Play, not with our stored `autoRenew`. Before refusing,
  the row's own token is read from Play once (`playRowStillRenews`). So a
  replacement that arrives without `linkedPurchaseToken` (old token reported
  replaced/cancelled) is accepted as the replacement, and a user who has just
  cancelled renewal in Play is not told to cancel it. If Play cannot be asked,
  only a row that is entitled right now is believed to renew. The website's
  `create-order` uses the same check, and also applies it to a row that is past
  its `endDate` but still `active` with `autoRenew` on (Play's grace period).
- A retired token is only ignored while it is dead. One that Play reports ACTIVE
  or in grace, renewing and not replaced, is being billed: it is treated as an
  ordinary purchase (409 if a Play plan renews, otherwise it becomes the current
  token again) and the server logs a warning. This is how a Play plan that was
  retired because a website purchase took over (or was cancelled and then
  resubscribed) cannot bill the user silently.
- A Play purchase that is already cancelled, and is no better than the running
  website plan (same or lower tier, ending no later), is acknowledged but not
  applied. The app replays every purchase it owns at each start; a restore must
  not trade a longer or higher paid plan for it. It applies normally once the
  website plan has run out.

**Where a notification goes** (`reconcilePlaySubscription`): the row whose
current token it is → a row that retired it (ignored unless live, see above) →
the row whose current token is its `linkedPurchaseToken` (the successor: this is
how a plan change lands while the app is closed) → the account id Play carries.
A token Play marks `canceledStateContext.replacementCancellation` never carries
entitlement; if it is still a row's current token three days after it ended and
no successor ever arrived, the row is ended.

**Races.** A plan switch produces two notifications at the same moment (old token
ends, new token starts) and the app's `verify` arrives beside them.

- Retiring a token uses `$addToSet`, not "assign a new array". Assigning makes
  Mongoose put `__v` in the save filter, so the second of two writers failed with
  a VersionError after the user had paid. `activateForPlayPurchase` also retries
  once on a VersionError or duplicate `userId`; the retry re-reads the row and
  lands on "already applied".
- Ending a row is compare-and-set on its status and token (`persistDeactivation`),
  so a stale "old token expired" can no longer undo the new plan, and the Business
  doc is re-synced if an activation slipped in between the two writes. The
  "own token, already applied" path also repairs a Business left behind the row.
- A token that expired in the last 15 minutes does not end its row (the
  successor's notification is probably on its way). If nothing arrives, the
  nightly job ends it on its next run, so after a normal expiry the Business doc
  can keep its tier for up to a day. Entitlement itself is unaffected: it is
  decided from `endDate`. Play offers no lookup from an old token to its
  successor, so a lost successor notification is only repaired when the app next
  opens (its `verify` carries the new token).

`GET /subscription/status` returns `subscription` without `playPurchaseToken`,
`redeemedPaymentIds` and `retiredPlayTokens`, plus a top-level `renewal`
(`source`, `autoRenew`, `endsOn`, `endsWithoutRenewal`, `pendingPlan`,
`pendingPlanAt`, `manageUrl`; `null` when there is no active plan).

Field names are from Google's `purchases.subscriptionsv2` reference:
`linkedPurchaseToken` (top level), `lineItems[0].deferredItemReplacement.productId`,
`lineItems[0].latestSuccessfulOrderId`, `canceledStateContext.replacementCancellation`.
The order id is read from the line item first; the top-level `latestOrderId`
the code used to read is only a fallback, because it is not in the current
resource.

The new index on `retiredPlayTokens` is built by mongoose when the server
starts (`src/db/index.js` does not turn `autoIndex` off). I did not look at the
production database to confirm it exists afterwards.

### Test checklist for plan changes (licence tester, Internal testing track)

Licence-tester subscriptions renew on an accelerated clock (monthly ≈ every
5 minutes), so each step below takes minutes. Watch the server log for
`[Play RTDN]` lines and read the row through `GET /subscription/status`.

- [ ] Small Business → Corporate in the app: one charge for the difference, the
      billing date does not move, status shows Corporate with `autoRenew` true,
      and Play shows ONE active subscription
- [ ] After that upgrade the old Small Business token's later notifications
      (expiry / cancel) do not change the plan
- [ ] Confirm what Play really sends for an upgrade: the new token carries
      `linkedPurchaseToken` and the account id (`obfuscatedExternalAccountId`);
      the old token reports `CANCELED` or `EXPIRED` with
      `canceledStateContext.replacementCancellation` (not verified yet)
- [ ] Corporate → Small Business in the app: no error is shown for the blank
      "purchased" event, `POST /sync` returns `reconciled: true`, status shows
      `renewal.pendingPlan = small_business` while the tier is still corporate
- [ ] Confirm Play lists `deferredItemReplacement` on the old token right after
      the downgrade (not verified yet)
- [ ] At the next renewal the plan switches to Small Business by itself with the
      app killed, `pendingPlan` clears, and a late notification for the Corporate
      token changes nothing
- [ ] Cancel renewal in Play (use `renewal.manageUrl`): status keeps the plan,
      shows `endsWithoutRenewal: true`, and the app does not show an error on
      the next launch; after the period the plan drops to Free
- [ ] Switch renewal back on before the period ends (RESTARTED): `autoRenew`
      returns to true
- [ ] While a Play plan renews, `POST /subscription/create-order` answers 409
      with the Google Play message; after cancelling renewal it succeeds
- [ ] A website purchase over a cancelled Play plan replaces it, and later Play
      notifications for the old token do not flip it back
- [ ] A second, plain Play purchase on a different product while one renews is
      refused with 409 and is not acknowledged (Play refunds it after 3 days)
- [ ] Upgrade while Play is slow to send the new token's `linkedPurchaseToken`
      (or does not send it): the purchase is still accepted and acknowledged,
      because the old token is read from Play and reports replaced/cancelled
- [ ] Cancel renewal in Play and open website checkout straight away: the order
      is created (the server reads the cancellation from Play, not from the
      last notification)
- [ ] Cancel a Play plan, buy on the website, then resubscribe to the Play plan:
      the row goes back to the Play plan and the server log shows
      "Retired Google Play token is live and renewing again"
- [ ] Deferred downgrade at renewal: watch the order of the two notifications
      (old token ending, new token starting). The plan must not drop to Free in
      between, and the final row must be Small Business on the new token with
      the Business doc on `plan2`
