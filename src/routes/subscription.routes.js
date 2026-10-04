import { Router } from 'express';
import {
    getSubscriptionStatus,
    checkFeatureAccess,
    getAvailablePlans,
    createSubscriptionOrder,
    verifySubscriptionPayment,
    subscriptionWebhook,
    verifyGooglePlayPurchase,
    syncGooglePlaySubscription,
    googlePlayNotification,
    testUpgradeSubscription
} from '../controllers/subscription/index.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { subscriptionSyncRateLimit } from '../middlewares/rateLimiter.middleware.js';

const router = Router();

// Public route — Cashfree webhook (no JWT)
router.post('/webhook', subscriptionWebhook);                    // POST /api/v1/subscription/webhook

// Public route — Google Play Real-time Developer Notifications, delivered by
// Cloud Pub/Sub, which has no user session. Authenticated by the shared secret
// in ?token= (GOOGLE_PLAY_RTDN_SECRET) inside the handler. Must stay ABOVE the
// verifyJWT below, for the same reason the Cashfree webhook does.
router.post('/google-play/notification', googlePlayNotification);

// Apply authentication middleware to all routes below
router.use(verifyJWT);

// Subscription information routes
router.get('/status', getSubscriptionStatus);                    // GET /api/v1/subscription/status
router.get('/feature/:feature/access', checkFeatureAccess);      // GET /api/v1/subscription/feature/calling/access
router.get('/plans', getAvailablePlans);                         // GET /api/v1/subscription/plans

// Cashfree payment routes for subscription upgrade (website + the physical
// goods store; still the only gateway the web app uses)
router.post('/create-order', createSubscriptionOrder);           // POST /api/v1/subscription/create-order
router.post('/verify-payment', verifySubscriptionPayment);       // POST /api/v1/subscription/verify-payment

// Google Play Billing — the Android app's subscription path. Play requires its
// own billing system for anything unlocking in-app functionality, so the app
// cannot use the Cashfree routes above for subscriptions.
router.post('/google-play/verify', verifyGooglePlayPurchase);    // POST /api/v1/subscription/google-play/verify

// Re-reads the caller's current Play subscription from Play (the app calls it
// after scheduling a downgrade, which Play may not announce straight away).
// Rate limited per user because every call is a request to Google.
router.post('/google-play/sync', subscriptionSyncRateLimit, syncGooglePlaySubscription); // POST /api/v1/subscription/google-play/sync

// @deprecated - TEST ONLY: Upgrade subscription without payment (for testing business features)
// This endpoint should not be used in production. Use /create-order and /verify-payment instead
if (process.env.NODE_ENV !== 'production') {
    router.post('/test-upgrade', testUpgradeSubscription);       // POST /api/v1/subscription/test-upgrade
}

// ===============================
// MONITORING & ADMIN ROUTES — MOVED
// ===============================
// /monitoring/* used to be registered here, below `router.use(verifyJWT)`, which
// is the ORDINARY user middleware: any signed-in account could read the platform
// payment log, internal error stack traces and whole-business revenue metrics,
// and could trigger the expiry job. The controllers already documented
// themselves as /api/v1/admin/monitoring/*, and that is where they now live —
// see routes/admin.routes.js, behind verifyAdminJWT + requirePermission.
// Nothing in the app or the website called the subscription-router paths.

export default router;
