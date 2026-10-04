# Calling Features Implementation - Paid vs Free Users

> **Current behaviour (this supersedes any older example below).**
> - Plan ids are `free`, `small_business` and `corporate`. Calling is included in
>   **both** paid plans; the Free plan has no audio or video calling.
> - **Placing** a call (`POST /calls/initiate`) needs an active paid subscription
>   (status `active`, `endDate` in the future), checked by `verifyCallingAccess` in
>   `src/middlewares/subscription.middleware.js`. A business profile does **not**
>   get calling for free: it needs the same paid subscription as anyone else.
> - Accepting, declining and ending a call are not gated, so a paid account can
>   always be answered by a Free customer and anyone can hang up.
> - What each plan includes (and its price) lives in one place: `buildPlanCatalog()`
>   and `SUBSCRIPTION_PLANS` in `src/controllers/subscription/plans.js`, served by
>   `GET /api/v1/subscription/plans`. Do not copy those lists into this document.
> - The sections below are the original implementation notes. Where they mention
>   `basic` / `pro` / `premium` / `business` tiers, dollar prices, an
>   `/upgrade-prompt` endpoint or automatic calling for business profiles, they are
>   out of date.

## Overview
This implementation adds subscription-based access control for calling features, restricting free users from accessing audio and video calls while granting unlimited access to paid users and business profiles.

## Requirements Implemented

### 1. Free Users
- ❌ **Cannot access audio calls**
- ❌ **Cannot access video calls**
- ✅ **Receive upgrade prompt when attempting to use call features**

### 2. Paid Users (Small Business, Corporate)
- ✅ **Audio calls**
- ✅ **Video calls**
- ✅ **Full calling feature access**

### 3. Business Users
- Business accounts follow the same rule as everyone else: calling needs an active
  Small Business or Corporate subscription. There is no automatic access.

## Files Modified/Created

### 1. User Model Enhancement
**File:** `src/models/user.models.js`

Added helper methods:
- `hasCallingAccess()` - Checks if user has calling features access
- `getSubscriptionTier()` - Returns user's subscription tier

```javascript
// Historical note: this helper (UserSchema.methods.hasCallingAccess) is not used by
// the call routes. The real gate is verifyCallingAccess in
// subscription.middleware.js: an active small_business or corporate subscription.
```

### 2. Subscription Middleware
**File:** `src/middlewares/subscription.middleware.js` (New)

Created three middleware functions:
- `verifyCallingAccess` - Blocks free users from calling endpoints with detailed error
- `attachSubscriptionInfo` - Adds subscription info to request without blocking
- `getUserSubscription()` - Helper function to get user subscription details

The error response for free users includes:
```json
{
  "errorCode": "CALLING_FEATURE_RESTRICTED",
  "subscriptionTier": "free",
  "requiresUpgrade": true,
  "availablePlans": ["small_business", "corporate"]
}
```

### 3. Subscription Controller
**File:** `src/controllers/subscription.controllers.js` (New)

Implemented endpoints:
- `GET /api/v1/subscription/status` - Get current subscription status
- ~~`GET /api/v1/subscription/upgrade-prompt`~~ - removed; it is no longer routed
- `GET /api/v1/subscription/feature/:feature/access` - Check feature access
- `GET /api/v1/subscription/plans` - Get all available plans

### 4. Subscription Routes
**File:** `src/routes/subscription.routes.js` (New)

Registered subscription endpoints with JWT authentication.

### 5. Call Routes Update
**File:** `src/routes/call.routes.js`

Updated routes to include access control:
```javascript
// Placing a call needs an active paid plan
router.post('/initiate', verifyCallingAccess, initiateCall);

// No restriction (a free user can answer a paid account, and anyone can decline/end)
router.patch('/:callId/accept', acceptCall);
router.patch('/:callId/decline', declineCall);
router.patch('/:callId/end', endCall);

// Attach subscription info for history/stats
router.get('/history', attachSubscriptionInfo, getCallHistory);
router.get('/active', attachSubscriptionInfo, getActiveCall);
router.get('/stats', attachSubscriptionInfo, getCallStats);
```

### 6. App Configuration
**File:** `src/app.js`

Registered subscription router:
```javascript
app.use("/api/v1/subscription", subscriptionRouter);
```

## API Endpoints

### Subscription Endpoints

#### 1. Get Subscription Status
```
GET /api/v1/subscription/status
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "subscription": {
      "userId": "...",
      "plan": "small_business",
      "status": "active",
      "endDate": "2026-02-15T00:00:00.000Z"
    },
    "tier": "small_business",
    "isBusinessProfile": false,
    "features": {
      "calling": {
        "hasAccess": true,
        "audioCall": true,
        "videoCall": true,
        "unlimited": true
      }
    }
  }
}
```

#### 2. Get Upgrade Prompt (removed)
`GET /api/v1/subscription/upgrade-prompt` is no longer routed. Clients that need
plan details call `GET /api/v1/subscription/plans`.

#### 3. Check Feature Access
```
GET /api/v1/subscription/feature/calling/access
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "feature": "calling",
    "hasAccess": false,
    "currentTier": "free",
    "requiredTier": "small_business",
    "isBusinessProfile": false,
    "requiresUpgrade": true
  }
}
```

#### 4. Get Available Plans
```
GET /api/v1/subscription/plans
Authorization: Bearer <token>
```

Response:
```json
{
  "success": true,
  "data": {
    "plans": [
      {
        "id": "free",
        "name": "Free",
        "price": "₹0",
        "features": [...],
        "limitations": [...]
      },
      // ... more plans (the lists come from buildPlanCatalog() in plans.js)
    ]
  }
}
```

### Call Endpoints Behavior

#### Initiate Call (Restricted)
```
POST /api/v1/calls/initiate
Authorization: Bearer <token>

Body:
{
  "receiverId": "...",
  "chatId": "...",
  "callType": "video" // or "voice"
}
```

**Free user response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Calling features are not available for free users. Please upgrade your subscription to access audio and video calls.",
  "data": {
    "errorCode": "CALLING_FEATURE_RESTRICTED",
    "subscriptionTier": "free",
    "requiresUpgrade": true,
    "availablePlans": ["small_business", "corporate"]
  }
}
```

**Paid user response (201 Created):**
```json
{
  "success": true,
  "data": {
    "callId": "...",
    "status": "initiated",
    "callType": "video",
    // ... call details
  }
}
```

## Subscription Tiers

The plans are `free`, `small_business` and `corporate`. Their prices and exactly
what each one includes are defined in one place only:
`src/controllers/subscription/plans.js` (`SUBSCRIPTION_PLANS` for the numeric
price, `buildPlanCatalog()` for the feature and limitation lists, with the
numeric limits read from `src/utils/planLimits.js`). The same data is served at
`GET /api/v1/subscription/plans`.

For calling specifically: Free has none; Small Business and Corporate both include
audio and video calling.

## How It Works

### Access Control Flow

1. **User Authentication**
   - User sends request with JWT token
   - `verifyJWT` middleware authenticates user

2. **Subscription Check** (for calling endpoints)
   - `verifyCallingAccess` middleware checks subscription
   - Active `small_business` or `corporate` subscription: ✅ Allowed
   - Everyone else, including business profiles without a paid plan: ❌ Blocked
     with a 403 `CALLING_FEATURE_RESTRICTED` response

3. **Call Initiation**
   - Only users with an active paid subscription can place a call
   - Free users receive a 403 error with upgrade information

4. **Call Accept/Decline/End**
   - No restriction - all users can accept, decline or end calls
   - This lets a paid account reach Free customers, and lets Free users reject calls

### Frontend Integration

When a free user tries to access calling:

```javascript
// Example frontend code
try {
  await initiateCall({ receiverId, chatId, callType: 'video' });
} catch (error) {
  if (error.response?.data?.data?.errorCode === 'CALLING_FEATURE_RESTRICTED') {
    // Show upgrade prompt
    const plans = await fetch('/api/v1/subscription/plans');
    showUpgradeModal(plans);
  }
}
```

## Testing

### Test Cases

1. **Free User - Initiate Call**
   - ❌ Should return 403 with upgrade prompt

2. **Free User - Accept Call**
   - ✅ Should work (no restriction)

3. **Free User - Decline Call**
   - ✅ Should work (no restriction)

4. **Free User - View Call History**
   - ✅ Should work (subscription info attached)

5. **Paid User - Initiate Call**
   - ✅ Should create call successfully

6. **Paid User - Accept Call**
   - ✅ Should accept call successfully

7. **Business Profile on the Free plan - Initiate Call**
   - ❌ Should return 403 (a business profile needs a paid plan to place calls)

8. **Business Profile on a paid plan - Initiate Call**
   - ✅ Should create call successfully

## Database Schema

The existing `Subscription` model is used:
```javascript
{
  userId: ObjectId,
  plan: 'free' | 'small_business' | 'corporate',
  status: 'active' | 'expired' | 'cancelled',
  startDate: Date,
  endDate: Date,
  paymentId: String,
  autoRenew: Boolean
}
```

## Security Considerations

1. **Server-Side Validation**: All subscription checks happen on the server
2. **JWT Authentication**: All endpoints require valid authentication
3. **Rate Limiting**: General rate limiting applies to all endpoints
4. **No Client Bypass**: Frontend cannot override subscription restrictions

## Future Enhancements

- [ ] Add group calling with tier-based participant limits
- [ ] Add call duration limits per plan (if needed)
- [ ] Add call quality settings based on subscription tier
- [ ] Track calling usage/analytics per user
- [ ] Add grace period for expired subscriptions
- [ ] WebSocket integration for real-time upgrade prompts

## Notes

- Business profiles (`isBusinessProfile: true`) do not get calling automatically; they need an active Small Business or Corporate subscription like everyone else
- Users can view their call history and stats regardless of subscription tier
- Free users can still decline or end calls (important for UX)
- The subscription check happens at the middleware level for clean separation of concerns
- Error responses include detailed information for frontend to show appropriate upgrade prompts
