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
