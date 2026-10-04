import rateLimit from 'express-rate-limit';
import { redisClient } from '../config/redis.config.js';

/**
 * Custom Redis store for express-rate-limit using existing ioredis client
 * This avoids IPv6 issues by using our already-configured Redis connection
 */
class RedisStore {
    constructor(options = {}) {
        this.client = options.client || redisClient;
        this.prefix = options.prefix || 'rl:';
        this.resetExpiryOnChange = options.resetExpiryOnChange ?? false;
        this.windowMs = options.windowMs || 60000; // Default 1 minute
    }

    async increment(key) {
        const prefixedKey = this.prefix + key;

        try {
            // Ensure windowMs is set
            if (!this.windowMs) {
                console.error('Redis rate limit error: windowMs not initialized');
                throw new Error('windowMs not initialized');
            }

            // Increment and get the new value
            const current = await this.client.incr(prefixedKey);

            // Set expiry on first increment
            if (current === 1) {
                await this.client.expire(prefixedKey, Math.ceil(this.windowMs / 1000));
            }

            // Get TTL (in milliseconds)
            const ttl = await this.client.pttl(prefixedKey);

            // Handle TTL edge cases:
            // -2 means key doesn't exist, -1 means no expiry set
            let resetTime;
            if (ttl > 0) {
                resetTime = new Date(Date.now() + ttl);
            } else if (ttl === -1) {
                // No expiry set, set it now and calculate reset time
                await this.client.expire(prefixedKey, Math.ceil(this.windowMs / 1000));
                resetTime = new Date(Date.now() + this.windowMs);
            } else {
                // Key doesn't exist or other error, use window from now
                resetTime = new Date(Date.now() + this.windowMs);
            }

            return {
                totalHits: current,
                resetTime: resetTime
            };
        } catch (error) {
            // NO FALLBACK EXISTS. express-rate-limit does not swap in a memory
            // store when a custom store fails — it awaits `increment()` and
            // reads `.totalHits` off whatever comes back, so returning
            // `undefined` here raised a TypeError inside the library, and with
            // the default `passOnStoreError: false` that TypeError was rethrown
            // and turned EVERY request through EVERY limiter into a 500 —
            // checkout and payment verification included.
            //
            // Throw honestly instead, and let each limiter declare via
            // `passOnStoreError` whether a Redis outage should let traffic
            // through (availability wins) or block it (security wins). See the
            // per-limiter settings below.
            console.error('CRITICAL: Redis rate limit increment error:', error);
            throw error;
        }
    }

    async decrement(key) {
        const prefixedKey = this.prefix + key;

        try {
            const current = await this.client.decr(prefixedKey);
            return Math.max(0, current);
        } catch (error) {
            console.error('Redis rate limit decrement error:', error);
            return 0; // Return 0 on error to avoid breaking the flow
        }
    }

    async resetKey(key) {
        const prefixedKey = this.prefix + key;

        try {
            await this.client.del(prefixedKey);
            return true;
        } catch (error) {
            console.error('Redis rate limit reset error:', error);
            return false;
        }
    }

    init(options) {
        if (options.windowMs) {
            this.windowMs = options.windowMs;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TWO SETTINGS THAT ARE NOT PER-LIMITER, DESPITE APPEARANCES
//
// 1. `trustProxy` inside a rateLimit() options object was removed in
//    express-rate-limit v7 and is silently ignored by the v8 installed here.
//    Every limiter carried one and none of them did anything. The real setting
//    is `app.set('trust proxy', 1)` in app.js — that is what makes `req.ip`
//    resolve to the client rather than the load balancer, and it is what every
//    IP-keyed limiter here depends on.
//
// 2. `passOnStoreError` decides what happens when Redis is unreachable:
//    `true`  → the request is allowed through un-limited (availability wins);
//    `false` → the store error propagates and the request 500s (security wins).
//    It defaults to FALSE, which is why a Redis blip used to 500 the whole API.
//    It is now set explicitly on every limiter: `true` for traffic shaping,
//    and deliberately `false` only where failing open would remove the sole
//    protection against brute force.
// ─────────────────────────────────────────────────────────────────────────────

// General rate limiter for most endpoints
export const generalRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 50000,
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: 60 // 60 seconds
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for OPTIONS requests (CORS preflight) and health check endpoints
    skip: (req) => {
        return req.method === 'OPTIONS' ||
               req.path === '/' ||
               req.path === '/health' ||
               req.path === '/api/v1/health';
    },
    // Traffic shaping only — never take the whole API down because Redis blinked.
    passOnStoreError: true,
    // Use custom Redis store
    store: new RedisStore({ prefix: 'rl:general:', windowMs: 1 * 60 * 1000 })
});

// Per-IP limiter for the OTP endpoints: every code that goes out and every
// code that comes back. The general limiter above allows 50,000 requests a
// minute, which is no limit at all against a walk through a 6-digit OTP —
// together with loginRateLimit below these are the only limiters in this file
// sized for an attacker rather than for traffic shaping.
//
// ATTACHED (user.routes.js) to the OTP verify routes — /register/verify,
// /verify-email-otp, /verify-update-phone, /verify-update-email,
// /reset-password — and to every route that SENDS a code: /register,
// /register/resend-otp, /send-verification-otp, /send-reset-otp,
// /send-phone-verification-otp, /send-email-change-otp, /send-email-update-otp.
// Sign-in is deliberately NOT on this limiter; see loginRateLimit below.
// 30/minute leaves ordinary retries and shared-NAT households alone.
export const authRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    message: {
        error: 'Too many attempts. Please wait a minute and try again.',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    // A successful sign-in should not spend the budget a failed one does.
    skipSuccessfulRequests: true,
    skip: (req) => req.method === 'OPTIONS',
    // FAILS OPEN, deliberately, and the reasoning matters because it was changed.
    //
    // This limiter is attached to fourteen routes, and they are not only OTP
    // verification: they include /register, /register/resend-otp, /send-reset-otp
    // and /reset-password. Failing closed there means a Redis blip stops anyone
    // signing up OR recovering a locked account — a total account-recovery
    // outage, self-inflicted by a cache, on the routes a user reaches for
    // precisely when they are already stuck.
    //
    // Failing open does NOT leave OTP guessing unbounded, because the control
    // that actually bounds it is in MongoDB, not Redis: attemptCount/lockedUntil
    // on the OTP record (_helpers.js assertOtpNotLocked / registerFailedOtpAttempt)
    // locks a code after 5 wrong tries and survives a Redis outage untouched.
    // The per-account failed-login throttle is likewise DB-backed.
    //
    // What is genuinely lost while Redis is down is the cross-account view — one
    // host spraying codes at many different accounts. That is a real but bounded
    // gap during a short outage, and it is the smaller of the two harms.
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:auth:', windowMs: 60 * 1000 })
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGN-IN. Same shape and same budget as authRateLimit, and it exists as a
// SEPARATE limiter for exactly one reason: it FAILS OPEN where authRateLimit
// fails closed.
//
// Putting /users/login behind a fail-closed limiter means a Redis outage
// returns 500 to every sign-in attempt on the platform — a total, self-inflicted
// authentication outage triggered by a cache blip, on the one route every
// session on both clients starts from.
//
// That trade is only worth making when the limiter is the sole control, and on
// this route it is not: assertLoginAttemptsAvailable in
// controllers/user/_helpers.js caps a single account at LOGIN_MAX_FAILURES (10)
// wrong passwords per 15 minutes and is the real defence against both password
// spraying and a targeted guess. So during the same outage the residual risk is
// bounded credential stuffing, while the cost of failing closed is unbounded:
// nobody signs in at all. Availability wins here.
//
// It still needs its own bucket (own prefix) so that OTP traffic and sign-in
// traffic do not spend each other's budget.
export const loginRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    message: {
        error: 'Too many sign-in attempts. Please wait a minute and try again.',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    // A successful sign-in should not spend the budget a failed one does.
    skipSuccessfulRequests: true,
    skip: (req) => req.method === 'OPTIONS',
    // Fails OPEN, deliberately — see the reasoning above. The per-ACCOUNT
    // failed-login throttle is the control that matters on this route, and it
    // also fails open, so behaviour during a Redis outage is at least coherent.
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:login:', windowMs: 60 * 1000 })
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN SIGN-IN. Separate from loginRateLimit on purpose, and it is the one
// limiter in this file that FAILS CLOSED.
//
// /admin/login had nothing in front of it but generalRateLimit (50,000/minute),
// which is no limit at all against a wordlist, and unlike /users/login there was
// no per-account throttle behind it either. It is the highest-value credential
// on the platform — escrow bookkeeping, seller bank details, user bans — and it
// is used by a handful of staff a few times a day, so the budget can be small
// enough to actually stop a walk without ever inconveniencing a real admin.
//
// FAILS CLOSED (`passOnStoreError: false`) because the reasoning that makes
// /users/login fail open does not carry over. There, failing open costs bounded
// credential stuffing and failing closed costs every user on both clients their
// sign-in; here, failing open removes a brute-force control on the one account
// that can move money, and failing closed costs a few staff the admin panel for
// the length of a Redis blip. The cheaper mistake is the second one.
// ADMIN_LOGIN_MAX_FAILURES in controllers/admin/auth.controllers.js adds the
// per-ACCOUNT half of this (an IP-keyed bucket alone is bypassed by rotating
// `x-forwarded-for`); that one is DB-of-record-free and fails open, so this
// limiter has to be the half that holds when Redis is unhealthy.
export const adminLoginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: {
        error: 'Too many admin sign-in attempts. Please try again later.',
        retryAfter: 900
    },
    standardHeaders: true,
    legacyHeaders: false,
    // A successful sign-in should not spend the budget a failed one does.
    skipSuccessfulRequests: true,
    skip: (req) => req.method === 'OPTIONS',
    passOnStoreError: false,
    store: new RedisStore({ prefix: 'rl:adminlogin:', windowMs: 15 * 60 * 1000 })
});

// ─────────────────────────────────────────────────────────────────────────────
// GUEST CHECKOUT (shareable product payment links)
//
// ONE LIMITER, KEYED ON THE IP. There used to be a second one keyed on the
// typed email address, and it has been REMOVED rather than tuned. Read this
// before adding another key an attacker gets to choose.
//
// WHAT THE PER-EMAIL BUCKET WAS FOR, AND WHY IT NO LONGER APPLIES.
// It was sized to bound ACCOUNT CREATION on a public route. But no account is
// created at order creation any more: guest accounts are minted only once a
// payment is CONFIRMED (utils/guestCheckout.utils.js → settleGuestOrder), and that
// is rate-limited by money far more effectively than by Redis. So the bucket
// was guarding a door that had already moved.
//
// WHY IT WAS WORSE THAN USELESS. Its key was a string the caller types, which
// means anyone could spend a chosen victim's budget for them. skipFailedRequests
// refunded rejected probes, but ten SUCCESSFUL unpaid order creations carrying
// the victim's address — trivially cheap, since creating an order costs nothing
// until it is paid — still emptied that address's bucket and locked the real
// owner out of guest checkout for a full hour. A targeted denial of service
// needing no access to the victim at all.
//
// WHAT ACTUALLY PROTECTS THIS ROUTE NOW:
//   1. THIS per-IP limiter, which is also the only one that can see account
//      enumeration. The 409 "an account already exists for this email" is a
//      membership oracle, and only a bucket that counts ACROSS DIFFERING EMAILS
//      can bound a walk through a list — a per-email bucket cannot, by
//      construction, because every probe uses a fresh address and so lands in a
//      fresh, empty bucket.
//   2. The controller resolving the post, the seller and the price BEFORE the
//      email check, so every probe must carry a real postId belonging to a real
//      business account at the real price.
//   3. Money: an order only becomes an account when it is actually paid for.
//
// SOFT LIMIT WARNING: this keys off `req.ip`, which express derives from
// `x-forwarded-for` under the `trust proxy` setting in app.js. Behind our own
// proxy that is the real client, but anyone who can reach the origin directly
// can still rotate it. Point 3 is the real backstop.
// ─────────────────────────────────────────────────────────────────────────────
export const guestCheckoutIpRateLimit = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 20,
    message: {
        error: 'Too many checkout attempts from this device. Please wait a few minutes and try again.',
        retryAfter: 600
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    // Counts EVERY attempt, successful or not: rejected probes are exactly what
    // this bucket exists to bound, so skipFailedRequests must stay off here.
    // Safe to count failures precisely BECAUSE the key is not attacker-chosen —
    // spending this bucket costs the attacker their own IP, not a victim's.
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:guestco:ip:', windowMs: 10 * 60 * 1000 })
});

// Support requests from one signed-in account. Generous for a real person with a
// problem, but it bounds what a loop can do to the admin inbox and to the shared
// SMTP quota that password-reset and OTP mail also depend on. Keyed by user id
// (the route runs verifyJWT first), not IP: the cost lands on the account sending.
export const feedbackRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: {
        error: "You have sent several messages in a short time. Please wait a while before sending another.",
        retryAfter: 3600
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    keyGenerator: (req) => String(req.user?._id || "anonymous"),
    passOnStoreError: true,
    store: new RedisStore({ prefix: "rl:feedback:", windowMs: 60 * 60 * 1000 })
});

// POST /subscription/google-play/sync. Unlike the other subscription routes it
// makes a call to Google's Developer API on every request (one purchases.
// subscriptionsv2.get), and that API has a quota the whole platform shares, so
// one account looping on it could starve the verify calls and the renewal
// notifications that real purchases depend on. A real user asks once, right
// after scheduling a plan change, so the budget is small. Keyed by user id (the
// route runs verifyJWT first), not IP, because the cost lands on the account
// making the calls. Fails open: it is traffic shaping, not a security control.
export const subscriptionSyncRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 6,
    message: {
        error: 'Too many refresh requests. Please wait a minute and try again.',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    keyGenerator: (req) => String(req.user?._id || 'anonymous'),
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:subsync:', windowMs: 60 * 1000 })
});

// Rate limiter for notification endpoints
export const notificationRateLimit = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    max: 10000,
    message: {
        error: 'Too many notification requests, please try again later.',
        retryAfter: 30
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:notif:', windowMs: 30 * 1000 })
});

// Rate limiter for unread counts endpoint
export const unreadCountsRateLimit = rateLimit({
    windowMs: 10 * 1000, // 10 seconds
    max: 5000,
    message: {
        error: 'Too many unread count requests. Consider using WebSocket events instead of polling.',
        retryAfter: 10,
        suggestion: 'Use real-time Socket.IO events for live updates instead of frequent API calls.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:unread:', windowMs: 10 * 1000 })
});

// Rate limiter for chat endpoints
export const chatRateLimit = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    max: 20000,
    message: {
        error: 'Too many chat requests, please try again later.',
        retryAfter: 30
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:chat:', windowMs: 30 * 1000 })
});

// Health check rate limiter (very lenient - only to prevent abuse)
export const healthCheckRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100000, // 100000 health checks per minute per user/IP (very high limit, only prevents abuse)
    message: {
        error: 'Too many health check requests.',
        retryAfter: 60
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for OPTIONS requests (CORS preflight)
    skip: (req) => req.method === 'OPTIONS',
    passOnStoreError: true,
    store: new RedisStore({ prefix: 'rl:health:', windowMs: 1 * 60 * 1000 })
});
