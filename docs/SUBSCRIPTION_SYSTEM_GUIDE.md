# 🚀 Subscription System - Complete Production Guide

## 📋 Table of Contents
1. [Overview](#overview)
2. [Features Implemented](#features-implemented)
3. [Setup & Configuration](#setup--configuration)
4. [API Endpoints](#api-endpoints)
5. [Webhook Configuration](#webhook-configuration)
6. [Cron Jobs](#cron-jobs)
7. [Monitoring & Logging](#monitoring--logging)
8. [Testing Guide](#testing-guide)
9. [Production Deployment](#production-deployment)
10. [Troubleshooting](#troubleshooting)

---

## Overview

> **Gateway note:** Cashfree is the only payment gateway. The Razorpay and
> PhonePe integrations were removed, along with `POST /api/v1/webhooks/razorpay`.
> `RAZORPAY_*` / `PHONEPE_*` environment variables are not read by anything.

The subscription system enables users to upgrade from free tier to paid plans (Small Business ₹19/mo, Corporate ₹999/mo) with:
- Cashfree payment integration (website) and Google Play Billing (Android app)
- Automatic subscription expiry handling
- Webhook support for payment notifications
- Comprehensive logging and monitoring
- Cache invalidation on subscription changes

---

## Features Implemented

### ✅ Core Features
- **3-Tier Subscription Plans**: Free, Small Business (₹19/mo), Corporate (₹999/mo). What each plan includes is defined once, in `buildPlanCatalog()` in `src/controllers/subscription/plans.js` (served by `GET /subscription/plans`); this guide does not repeat the feature lists.
- **Cashfree Payment Gateway**: Server-side order-status verification plus signed webhooks
- **Subscription Management**: Create, upgrade, and expire subscriptions
- **Business Profile Sync**: Auto-sync subscription status with business profiles
- **Calling Features**: Audio/video calls restricted to paid users (both Small Business and Corporate)
- **Renewal by channel**: Google Play subscriptions (Android app) renew automatically every month until cancelled in Google Play. Cashfree (website) purchases cover one month and do not renew automatically; a new order is needed to extend. When a plan ends the account returns to Free and paid-only features stop; content is not deleted.

### ✅ Production-Ready Features
- **Webhook Handler**: Processes Cashfree payment events asynchronously
- **Cron Jobs**: Auto-expire subscriptions and send renewal reminders
- **Monitoring System**: Comprehensive logging of payments, subscriptions, and errors
- **Cache Invalidation**: Auto-clear caches when subscription changes
- **Metrics Collection**: Track payment success rates and revenue

---

## Setup & Configuration

### 1. Environment Variables

Add these to your `.env` file:

```bash
# Cashfree Configuration
CASHFREE_APP_ID=YOUR_APP_ID                    # Sandbox app id (replace with live in production)
CASHFREE_SECRET_KEY=YOUR_SECRET_KEY            # Also used to verify webhook signatures
CASHFREE_ENV=sandbox                           # Change to 'production' in production

# Environment
NODE_ENV=development  # Change to 'production' in production
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Database Indexes

The subscription system requires proper indexes. Run:

```bash
npm run db:indexes
```

---

## API Endpoints

### 📊 Subscription Information

#### Get Subscription Status
```http
GET /api/v1/subscription/status
Authorization: Bearer <token>
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "subscription": { /* subscription object */ },
    "tier": "small_business",
    "isBusinessProfile": true,
    "features": {
      "calling": {
        "hasAccess": true,
        "audioCall": true,
        "videoCall": true
      }
    }
  }
}
```

#### Get Available Plans
```http
GET /api/v1/subscription/plans
Authorization: Bearer <token>
```

#### Check Feature Access
```http
GET /api/v1/subscription/feature/:feature/access
Authorization: Bearer <token>
```

Example: `/api/v1/subscription/feature/calling/access`

### 💳 Payment Flow

#### Step 1: Create Cashfree Order
```http
POST /api/v1/subscription/create-order
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan": "small_business"  // or "corporate"
}
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "cashfreeOrderId": "CF-...",
    "checkoutUrl": "https://payments.cashfree.com/order/#...",
    "paymentSessionId": "session_...",
    "cashfreeMode": "sandbox",
    "plan": "small_business",
    "planName": "Small Business",
    "planPrice": 19
  }
}
```

#### Step 2: Complete Payment on Frontend

Send the buyer to the Cashfree hosted checkout:

```javascript
window.location.href = response.checkoutUrl;
```

Cashfree redirects back to the configured return URL once the payment resolves.

#### Step 3: Verify Payment
```http
POST /api/v1/subscription/verify-payment
Authorization: Bearer <token>
Content-Type: application/json

{
  "cashfreeOrderId": "CF-...",
  "plan": "small_business"
}
```

> The client does **not** send a signature. The server calls Cashfree and asks
> what that order's status is. This is deliberate — a client-supplied signature
> is a forgeable claim, whereas the gateway's own answer is not.

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "subscription": { /* activated subscription */ },
    "business": { "plan": "plan2", "subscriptionStatus": "active" },
    "tier": "small_business",
    "features": { /* feature access */ },
    "message": "Successfully upgraded to Small Business plan!",
    "paymentId": "pay_abc"
  }
}
```

### 📊 Monitoring Endpoints

#### Get Monitoring Dashboard
```http
GET /api/v1/subscription/monitoring/dashboard
Authorization: Bearer <token>
```

#### Get Payment Logs
```http
GET /api/v1/subscription/monitoring/payment-logs?lines=50
Authorization: Bearer <token>
```

#### Get Subscription Logs
```http
GET /api/v1/subscription/monitoring/subscription-logs?lines=50
Authorization: Bearer <token>
```

#### Get Error Logs
```http
GET /api/v1/subscription/monitoring/error-logs?lines=50
Authorization: Bearer <token>
```

#### Get Metrics
```http
GET /api/v1/subscription/monitoring/metrics
Authorization: Bearer <token>
```

**Response:**
```json
{
  "statusCode": 200,
  "data": {
    "totalPayments": 150,
    "successfulPayments": 142,
    "failedPayments": 8,
    "totalRevenue": 141858,
    "successRate": "94.67%",
    "subscriptionsByPlan": {
      "small_business": 95,
      "corporate": 47
    }
  }
}
```

#### Test Expiry Job
```http
POST /api/v1/subscription/monitoring/test-expiry-job
Authorization: Bearer <token>
```

---

## Webhook Configuration

### 1. Setup Webhook in the Cashfree Dashboard

1. Open the Cashfree merchant dashboard → Webhooks.
2. Add the subscription webhook URL:
   `https://yourdomain.com/api/v1/subscription/webhook`
3. The signing secret is `CASHFREE_SECRET_KEY` — there is no separate webhook
   secret to configure.

The other two Cashfree webhooks belong to the commerce flows, not subscriptions:

```
https://yourdomain.com/api/v1/payments/webhook           # chat / escrow orders
https://yourdomain.com/api/v1/payments/cashfree/webhook  # online-store orders
```

### 2. Webhook Endpoint

```http
POST /api/v1/subscription/webhook
Content-Type: application/json
x-webhook-signature: <base64 HMAC-SHA256>
x-webhook-timestamp: <timestamp>

{
  "data": {
    "order":   { "order_id": "CF-...", "order_status": "PAID" },
    "payment": { "cf_payment_id": 12345, "payment_status": "SUCCESS" }
  }
}
```

The handler acts only on `order_status: PAID` + `payment_status: SUCCESS`, and
signature verification is mandatory — it is the only authentication this route
has. The signature is computed over the **raw** request body, which is why
`src/app.js` captures `req.rawBody` in the `express.json` verify hook. Anything
that consumes or rewrites the body before that will break every callback.

### 3. Test Webhook

```http
GET /api/v1/webhooks/test
```

---

## Cron Jobs

### Subscription Expiry Job

**Schedule:** Every day at 2:00 AM (Asia/Kolkata timezone)

**What it does:**
1. Finds all expired subscriptions (endDate < now)
2. Updates subscription status to 'expired'
3. Downgrades business profiles to plan1 (free)
4. Updates business subscriptionStatus to 'pending'
5. Invalidates cache for affected users

**Location:** `src/jobs/subscriptionExpiry.job.js`

### Expiry Reminder Job

**Schedule:** Every day at 10:00 AM

**What it does:**
- Sends reminders 7, 3, and 1 day before subscription expiry
- Currently logs to console (implement email/push notification)

### Manual Testing

Run expiry check manually via API:
```http
POST /api/v1/subscription/monitoring/test-expiry-job
```

---

## Monitoring & Logging

### Log Files

All logs are stored in `logs/` directory:

- `logs/payments.log` - All payment transactions
- `logs/subscriptions.log` - Subscription lifecycle events
- `logs/errors.log` - Error tracking
- `logs/metrics.log` - Performance and business metrics

### Log Format

```json
{
  "timestamp": "2025-01-21T10:30:00.000Z",
  "level": "INFO",
  "message": "Payment Successful",
  "data": {
    "userId": "user123",
    "paymentId": "pay_abc",
    "orderId": "order_xyz",
    "plan": "small_business",
    "amount": 19,
    "status": "success"
  },
  "environment": "production"
}
```

### Metrics Tracked

- Total payment attempts
- Successful vs failed payments
- Total revenue
- Success rate percentage
- Subscriptions by plan tier

---

## Testing Guide

### 1. Test Payment Flow (Development)

Use test endpoint (only available in development):
```http
POST /api/v1/subscription/test-upgrade
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan": "small_business"
}
```

**⚠️ This endpoint is disabled in production!**

### 2. Test the Cashfree Integration

Set `CASHFREE_ENV=sandbox` with sandbox credentials and use Cashfree's sandbox
test instruments (see the Cashfree sandbox docs for the current card/UPI list —
do not hard-code them here, they change).

Note that `/verify-payment` asks Cashfree for the order status server-side, so
there is no signature a harness can forge: a genuine pass requires completing
the hosted checkout at the returned `checkoutUrl`.

### 3. Test Webhook Locally

Use ngrok to expose local server:
```bash
ngrok http 3000
```

Then point the Cashfree dashboard webhook at the ngrok URL. Signature
verification still applies, and there is a replay window on
`x-webhook-timestamp` — if your machine's clock has drifted, valid callbacks
will be rejected as stale.

### 4. Test Expiry Job

```http
POST /api/v1/subscription/monitoring/test-expiry-job
```

### 5. Test Cache Invalidation

1. Create subscription
2. Check logs for cache invalidation messages
3. Verify feeds are refreshed

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] Update Cashfree keys to **live credentials**
  ```bash
  CASHFREE_APP_ID=YOUR_LIVE_APP_ID
  CASHFREE_SECRET_KEY=YOUR_LIVE_SECRET_KEY
  CASHFREE_ENV=production
  ```

- [ ] Set environment to production
  ```bash
  NODE_ENV=production
  ```

- [ ] Configure webhook URL in the Cashfree dashboard
  ```
  https://yourdomain.com/api/v1/subscription/webhook
  ```

- [ ] Confirm the raw-body capture in `src/app.js` is intact (webhook signatures
      are computed over the raw body)

- [ ] Test payment flow end-to-end
- [ ] Verify cron jobs start on server boot
- [ ] Check log files are being created
- [ ] Monitor first few transactions closely

### Deployment Commands

```bash
# Build (if needed)
npm run build

# Start with PM2 (production)
npm run pm2:start:prod

# Check logs
npm run pm2:logs

# Monitor status
npm run pm2:status
```

### Post-Deployment Verification

1. **Check server started correctly:**
   ```bash
   curl https://yourdomain.com/health
   ```

2. **Verify cron jobs are running:**
   - Check server logs for: "✅ Subscription expiry cron jobs started"

3. **Test webhook endpoint:**
   ```bash
   curl https://yourdomain.com/api/v1/webhooks/test
   ```

4. **Monitor first payment:**
   - Watch logs in real-time: `npm run pm2:logs`
   - Check payment logs: `logs/payments.log`

---

## Troubleshooting

### Payment Creation Fails

**Symptom:** Error creating Cashfree order

**Solutions:**
1. Check `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` are correct
2. Confirm `CASHFREE_ENV` matches the credentials (sandbox keys will not work
   against production, or vice versa)
3. Check Cashfree API status
4. Review error logs: `logs/errors.log`

### Payment Verification Fails

**Symptom:** Verification reports the order is not paid

**Solutions:**
1. Confirm the `cashfreeOrderId` sent is the one returned by `/create-order`
2. Remember verification is server-side — the order must actually be `PAID` at
   Cashfree; there is no client signature involved
3. Review payment logs for details

### Webhook Not Working

**Symptom:** Payments succeed but subscription not activated

**Solutions:**
1. Verify webhook URL is correct in the Cashfree dashboard
2. Confirm `req.rawBody` is still captured in `src/app.js` — signatures are
   computed over the raw body
3. Check server clock drift: callbacks outside the replay window on
   `x-webhook-timestamp` are rejected
4. Check server logs for webhook events
5. Ensure webhook endpoint is accessible publicly

### Cron Job Not Running

**Symptom:** Expired subscriptions not being processed

**Solutions:**
1. Check server logs for cron job initialization
2. Verify timezone is correct (default: Asia/Kolkata)
3. Manually trigger: `POST /api/v1/subscription/monitoring/test-expiry-job`
4. Check server is not being restarted frequently
5. Verify `node-cron` is installed

### Cache Not Invalidating

**Symptom:** Old subscription data showing in feeds

**Solutions:**
1. Check Redis connection
2. Verify cache keys match pattern: `fn:user:*:feed:*`
3. Check error logs for cache invalidation failures
4. Manually clear Redis: `redis-cli FLUSHDB`

### Logs Not Being Created

**Symptom:** No log files in `logs/` directory

**Solutions:**
1. Verify `logs/` directory exists (created automatically)
2. Check file write permissions
3. Verify monitoring utils are imported correctly
4. Check disk space

---

## Important Notes

### Security

- ✅ Webhook signature verification implemented
- ✅ Payment signature verification implemented
- ✅ JWT authentication on all routes
- ✅ No secrets exposed in code
- ✅ Proper input validation

### Best Practices

1. **Always verify payments** - Never trust client-side payment success
2. **Use webhooks** - Handle edge cases where user closes payment window
3. **Monitor logs** - Regularly check for failed payments
4. **Test thoroughly** - Use Cashfree sandbox mode before going live
5. **Cache invalidation** - Always clear caches after subscription changes

### Financial Compliance

- All payment transactions are logged for audit trail
- Log retention: Consider implementing log rotation
- PCI compliance: Never log full card details
- Refunds: Implement refund tracking if needed

---

## Support & Maintenance

### Regular Tasks

**Daily:**
- Monitor payment success rate
- Check for failed payments
- Review error logs

**Weekly:**
- Analyze subscription metrics
- Check expiry reminder effectiveness
- Review webhook logs

**Monthly:**
- Revenue reconciliation with Cashfree
- Subscription churn analysis
- System performance review

### Need Help?

- Cashfree Documentation: https://docs.cashfree.com/
- Cashfree Support: https://www.cashfree.com/help-support/
- Server Logs: `npm run pm2:logs`
- Monitoring Dashboard: `/api/v1/subscription/monitoring/dashboard`

---

## Version History

**v1.1.0** (Current)
- ✅ Cashfree is the sole payment gateway
- ✅ Razorpay and PhonePe integrations removed (config, routes, controllers,
     the `razorpay` npm dependency, and `POST /api/v1/webhooks/razorpay`)

**v1.0.0**
- ✅ Core subscription system
- ✅ Razorpay payment integration (removed in v1.1.0)
- ✅ Webhook handler
- ✅ Cron jobs for expiry
- ✅ Monitoring and logging
- ✅ Cache invalidation

**Future Enhancements:**
- Email/SMS notifications for expiry reminders
- Auto-renewal support
- Promo codes and discounts
- Usage-based billing
- Invoice generation

---

## Quick Reference

### Key Files

```
src/
├── controllers/
│   ├── subscription/payment.js        # Cashfree order, verify, webhook, activation
│   ├── subscription.controllers.js    # Main subscription logic
│   └── monitoring.controllers.js      # Monitoring endpoints
├── config/
│   └── cashfree.config.js             # Cashfree gateway client
├── jobs/
│   └── subscriptionExpiry.job.js      # Cron jobs
├── routes/
│   ├── subscription.routes.js         # Subscription routes
│   └── webhook.routes.js              # Webhook routes
├── models/
│   ├── subscription.models.js         # Subscription schema
│   └── business.models.js             # Business schema
├── middlewares/
│   └── subscription.middleware.js     # Access control
└── utlis/
    └── monitoring.utils.js            # Logging utilities
```

### Environment Variables Summary

```bash
CASHFREE_APP_ID=XXX
CASHFREE_SECRET_KEY=XXX
CASHFREE_ENV=production
NODE_ENV=production
```

---

**🎉 Your subscription system is production-ready!**

For questions or issues, check the troubleshooting section or review server logs.
