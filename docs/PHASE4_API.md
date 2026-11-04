# Phase 4 API (business trust, money and SEO)

Base URL: `/api/v1`. Responses use the usual `{ statusCode, data, message }` envelope. Unless a route says otherwise, it needs a signed-in user.

## Who sees business posts (#74, #78, §5.1)

These rules apply to product, service and business posts only. Ordinary posts and vibes are never affected.

| Business status | Who sees its product, service and business posts |
|---|---|
| KYC not verified | Only the business itself |
| Verified, no active plan | Its followers and the people it follows |
| Verified, Small Business plan | Everyone |
| Verified, Corporate plan (Premium) | Everyone, and its posts come first |

- **Where the rules apply:** home feed, vibes, explore, search, trending, other people's profile grids and post detail. Post detail answers 403 when the viewer isn't allowed.
- **Businesses approved before Phase 4 (Q10):** they count as verified. Once the automatic check is available (Cashfree keys set), the hourly job gives them 30 days (`KYC_RECHECK_GRACE_DAYS`) to complete it.
- **Regular users (#80):** their product and service posts show to followers as before. In explore and search they appear only while a paid listing is active.
- **Fallback:** the admin setting `KYC_VISIBILITY_MODE = 'legacy'` switches back to the old rule, where an active plan is enough.
- **Stored tier:** `Business.visibilityTier` is refreshed hourly and feeds the sitemap.

## KYC (#79, #30, #4)

| Method and path | Body | Notes |
|---|---|---|
| `GET /kyc/business` | – | Returns `{ status, registrationType, gstin, pan (masked), aadhaarLast4, reasons, badge, visibility, recheckDueAt, detailsLocked, detailsConfirmation, lockedFields, autoCheckAvailable, reKycFee }`. |
| `POST /kyc/business/aadhaar/otp` | `{ aadhaar }` | Unregistered businesses. Returns `{ refId, last4 }`. Without keys it returns 503. |
| `POST /kyc/business/aadhaar/verify` | `{ refId, otp, last4 }` | |
| `POST /kyc/business` | `{ registrationType: 'registered', gstin, pan }` or `{ registrationType: 'unregistered', pan }` | Runs the Cashfree checks. See "How a submission is decided" below. |
| `POST /kyc/business/send-confirmation` | – | Re-sends the confirmation email. |
| `GET /kyc/business/confirm-details?b&a&s&t` | – | Public. The Confirm and Reject links in the email. Confirm locks the details. |
| `GET /kyc/me` | – | A regular user's Aadhaar status. |
| `POST /kyc/me/aadhaar/otp`, `POST /kyc/me/aadhaar/verify` | as above | Regular users; needed before a paid listing (#80). |
| `GET /kyc/trust/:userId` | – | Returns `{ isBusiness, verified, badge, showUnverifiedWarning, warning, outsidePaymentNotice }` for the chat banner (#75). |

**How a submission is decided**
- **Checks:** for a registered business, the GSTIN must be active and must contain the PAN, and the names on the GST and PAN records must match the business name (70+ on a 0–100 score). For an unregistered business, the PAN and Aadhaar names must match.
- **Clean pass:** the business is verified at once, and the confirmation email is sent.
- **Anything else:** the business goes to the admin queue (`kyc.status = needs_review`). This includes when the Cashfree keys are not set.
- **Badges:** `registered_business` or `verified_seller`.
- **Notifications:** sent with type `kyc`.

**Locked details (#4).** After the business confirms by email, these fields can't be changed:
- business name and business type
- GSTIN and PAN
- address, city, state and postal code

`PUT /business/profile` answers 423 with `data.code = DETAILS_LOCKED` when a request tries to change them. Paying the re-KYC fee unlocks them so the business can edit and submit again.

Only the result, the name on record and the last 4 digits of an Aadhaar number are stored. The full number never is.

## Payments to Findernate (#27, #74, #77, #80)

`kind` is one of `ad`, `listing`, `re_kyc` or `plus`.

| Method and path | Notes |
|---|---|
| `GET /platform-payments/config` | Returns the prices and Play product ids. `iosPurchases: false`. |
| `POST /platform-payments/:kind/checkout` `{ refId? }` | Website (Cashfree). Returns `{ paymentSessionId, checkoutUrl, cashfreeMode, total }`. The return URL is `/payments/platform/return?orderId=`. |
| `POST /platform-payments/verify` `{ cashfreeOrderId }` | Settles the payment and fulfils it. A webhook (`/platform-payments/webhook`) and a 10-minute job also settle missed payments. |
| `POST /platform-payments/:kind/play` `{ refId?, productId, purchaseToken }` | Android (Google Play one-time products). Verified with Play, fulfilled, then consumed. |
| `GET /platform-payments/mine` | The user's receipts. |

**What fulfilment does**
- **Ad:** scheduled, or running straight away.
- **Listing:** live for 30 or 60 days.
- **Re-KYC:** the details are unlocked.
- **Plus:** 30 days without ads.

**Default Play product ids** (override with the `PLAY_PRODUCT_IDS` setting):
- `re_kyc_fee`
- `listing_30_days`, `listing_60_days`
- `findernate_plus_30_days`
- `ad_1_day`, `ad_3_days`, `ad_7_days`, `ad_15_days`, `ad_30_days`

## Ads (#27)

| Method and path | Notes |
|---|---|
| `GET /ads/config` | `{ enabled, dailyFee, minDays, maxDays, feedInterval, frequencyCap, gstPercent, types, playProducts }` |
| `POST /ads` | `{ type: contact\|app\|website, postId? \| creative: { headline, body, mediaUrl, mediaType }, cta: { label, whatsapp, phone, url, playStoreUrl, appStoreUrl }, days, startAt? }`. Creates a draft with its price. |
| `GET /ads/mine`, `GET /ads/:id`, `DELETE /ads/:id` | The dashboard. Each ad has its status, start and end dates, `stats { impressions, clicks, ctr, daily }`, and its payment. Only an unpaid draft can be cancelled. |
| `GET /ads/serve?count=` | Optional sign-in. Returns `{ ads, interval, adFree }`. Rotation is fair (fewest impressions first), each ad is shown at most `AD_FREQUENCY_CAP` times per person per day, and subscribers get none (#77). |
| `POST /ads/:id/impression`, `POST /ads/:id/click` | Counters. Clicks count once per person per day. |

**Statuses:** draft → awaiting_payment → scheduled → running → completed, plus cancelled and rejected. A 5-minute job moves ads between statuses and notifies the advertiser when an ad ends.

**Showing ads:** clients insert one "Sponsored" card every `interval` posts or vibes, with the call-to-action button.

## One-time listings (#80)

| Method and path | Notes |
|---|---|
| `GET /listings/config` | `{ available, fees: { 30, 60 }, gstPercent, aadhaarVerified, aadhaarCheckAvailable }` |
| `POST /listings` | `{ postId, days: 30\|60 }`. Needs a verified Aadhaar (otherwise 403 `AADHAAR_REQUIRED`). Automatic checks run on the post: price, title, media, banned items, contact details in the title. If any check flags it, the listing goes to the admin queue (`flagged`); otherwise it's `awaiting_payment`. |
| `GET /listings/mine`, `DELETE /listings/:id` | |

A listing expires hourly once its end date passes, and the owner is told. Renewing means creating a new listing.

## Business growth

| Method and path | Notes |
|---|---|
| `GET /business-growth/views?days=30` | #75. Daily profile views and business-post views, for verified businesses. |
| `GET /business-growth/statements?role=seller\|buyer&from&to[&format=csv]` | #74. Each line shows whether the order was B2B, the commission and the seller's net amount. |
| `GET /business-growth/plus` | #77. The plan for regular users: `{ available, comingSoon, price, includesCalling, active, validUntil, daysLeft, expiryLabel }`. |

**Commission on orders (Q11).** Every new order records `isB2B`, `commissionRate`, `commissionAmount` and `sellerNetAmount`:
- 10% (`B2B_COMMISSION_RATE`) when buyer and seller are both verified businesses.
- Otherwise `PLATFORM_FEE` (2.5%).

**View notifications (#75, Q16).** Verified businesses get an instant notification for each of the first 3 profile views a day (`BUSINESS_VIEW_INSTANT_LIMIT`), then a digest at 20:05 IST. Visitors who hide their profile visits appear as "Someone".

**Plan reminders (#77).** Sent 15, 3 and 1 days before the plan ends, and on expiry.

## SEO (#1), public

| Method and path | Notes |
|---|---|
| `GET /seo/sitemap?type=posts\|businesses&page` | Indexable items only: posts from businesses visible to everyone. |
| `GET /seo/post/:id` | Data for the server-rendered listing page and its structured data. Returns `{ indexable: false }` when the post must not be indexed. |
| `GET /seo/business/:username` | Data for a business profile page. |

## Admin

| Method and path | Notes |
|---|---|
| `GET /admin/kyc?status=needs_review`, `POST /admin/kyc/:businessId/decision` | `{ decision: approve\|reject, note }`. |
| `GET /admin/listings?status=flagged`, `POST /admin/listings/:id/decision` | Same body as above. |
| `GET /admin/ads?status=`, `POST /admin/ads/:id/reject` | `{ reason }`. |
| `GET /admin/b2b/statements?from&to` | Platform totals and commission. |

Approving a business through the old `verifyBusinessAccount` also sets its KYC to verified.

## Settings (admin settings, all optional)

| Key | Default | For |
|---|---|---|
| `KYC_VISIBILITY_MODE` | `enforce` | `legacy` turns the Phase 4 visibility rules off |
| `KYC_RECHECK_GRACE_DAYS` | 30 | Q10 |
| `RE_KYC_FEE` | 100 | #74 |
| `PLATFORM_GST_PERCENT` | 18 | All Findernate fees |
| `B2B_COMMISSION_RATE` | 0.10 | #74 |
| `AD_DAILY_FEE`, `AD_MIN_DAYS`, `AD_MAX_DAYS` | 100, 1, 30 | #27 |
| `AD_FEED_INTERVAL`, `AD_FREQUENCY_CAP`, `ADS_ENABLED` | 6, 3, true | #27 |
| `LISTING_FEE_30`, `LISTING_FEE_60` | not set (off) | #80 (Q15) |
| `PLUS_PLAN_PRICE`, `PLUS_PLAN_INCLUDES_CALLING` | not set (off), false | #77 (Q12) |
| `BUSINESS_VIEW_INSTANT_LIMIT` | 3 | #75 |
| `PLAY_PRODUCT_IDS` | see above | Android products |

## Environment

`CASHFREE_VERIFY_CLIENT_ID`, `CASHFREE_VERIFY_CLIENT_SECRET`, `CASHFREE_VERIFY_ENV` (sandbox or production) are the Cashfree Verification Suite credentials. Without them every submission goes to the admin queue, and Aadhaar checks answer 503.

## Jobs

| Job | When |
|---|---|
| Ads start and stop | Every 5 minutes |
| Missed Cashfree payments | Every 10 minutes |
| Listing expiry | Hourly |
| Stored tiers and the Q10 recheck | Hourly |
| Business views digest | 20:05 IST |
| Plus reminders | 10:20 IST |
