import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import morgan from 'morgan';
import helmet from 'helmet';
import { errorHandler } from './middlewares/errorHandler.js';
import { requestContext, requestLogger } from './middlewares/requestContext.js';
import { redisHealthCheck } from './config/redis.config.js';
import { generalRateLimit, healthCheckRateLimit } from './middlewares/rateLimiter.middleware.js';

const app = express();

// Security headers middleware - Helmet.js
app.use(helmet({
        contentSecurityPolicy: false, // Disable CSP for now to avoid breaking existing functionality
        crossOriginEmbedderPolicy: false // Needed for some CDN integrations
}));

// Request id + failure logging. Mounted first so the id exists for every
// later middleware, including the ones that reject a request before it ever
// reaches a route. Unlike morgan below this is always on: it only writes for
// failures and slow requests, which is the difference between having something
// to read when a user reports a problem and having nothing.
app.use(requestContext);
app.use(requestLogger);

// Morgan logging middleware - Only in development mode
if (process.env.NODE_ENV === 'development') {
        // Dev format: Colored output with method, url, status, response time
        app.use(morgan('dev'));
} else if (process.env.ENABLE_MORGAN === 'true') {
        // Production: Can be enabled via environment variable if needed for debugging
        // Combined format: Standard Apache combined log output
        app.use(morgan('combined'));
}

// Performance middleware - Enable gzip compression
app.use(compression({
        filter: (req, res) => {
                if (req.headers['x-no-compression']) {
                        return false;
                }
                return compression.filter(req, res);
        },
        level: 6, // Compression level 1-9 (6 is good balance)
        threshold: 1024, // Only compress responses > 1KB
}));


const allowedOrigins = [
        "https://p0k804os4c4scowcg488800c.194.164.151.15.sslip.io",
        "https://ywcsg0kokg00gwcowoogggwg.194.164.151.15.sslip.io",
        "https://xos8kg4cwsk0ckgwg4wcgk48.194.164.151.15.sslip.io",
        "http://xgoow8wg8wgso0k0g8o48ckc.194.164.151.15.sslip.io",
        "https://xgoow8wg8wgso0k0g8o48ckc.194.164.151.15.sslip.io",
        "http://ywcsg0kokg00gwcowoogggwg.194.164.151.15.sslip.io",
        "https://lcks40o4goog4og4c048skgs.194.164.151.15.sslip.io",
        "https://findernate.com",
        "https://www.findernate.com",
        "https://apis.findernate.com", // API domain
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:4000",
        "https://localhost:4000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:4000",
        "https://z0n8vrlt-4000.inc1.devtunnels.ms",
         /^https?:\/\/[\w-]+\.194\.164\.151\.15\.sslip\.io$/,
        "https://apis.findernate.com",
        // Allow all local network IPs for development
        ...(process.env.NODE_ENV === 'development' ? [/^http:\/\/192\.168\.\d+\.\d+:4000$/] : []),
        ...(process.env.ADDITIONAL_CORS_ORIGINS ? process.env.ADDITIONAL_CORS_ORIGINS.split(',') : [])
];


app.use(cors({
        origin: function (origin, callback) {
                // Allow requests with no origin (mobile apps, Postman, etc.)
                if (!origin) {
                        return callback(null, true);
                }

                // Check exact match first
                if (allowedOrigins.includes(origin)) {
                        return callback(null, true);
                }

                // Check regex patterns (for local network IPs)
                const regexPatterns = allowedOrigins.filter(pattern => pattern instanceof RegExp);
                for (const pattern of regexPatterns) {
                        if (pattern.test(origin)) {
                                return callback(null, true);
                        }
                }

                console.warn(`CORS blocked origin: ${origin}`);
                callback(new Error("Not allowed by CORS"));
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: [
                "Content-Type",
                "Authorization",
                "X-Requested-With",
                "Accept",
                "Origin",
                "Cache-Control",
                "Pragma",
                "Expires",
                "Access-Control-Request-Method",
                "Access-Control-Request-Headers",
                // Without this the browser preflight rejects a request that
                // carries a correlation id, so the website could never send one.
                "X-Request-Id"
        ],
        // exposedHeaders is an allow-list: a response header the browser is
        // not told to expose is unreadable from JavaScript even though it
        // arrived. X-Request-Id was being set on every response and silently
        // hidden from the one tier that most needed it — the website could not
        // report the id of the request that just failed.
        // The mobile app is unaffected; CORS does not apply to it.
        exposedHeaders: ["Set-Cookie", "X-Request-Id"],
        optionsSuccessStatus: 200,
        preflightContinue: false
}));

// Request parsing middleware - Must come after CORS
// Capture raw body for webhook HMAC verification (Cashfree)
app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Trust exactly one proxy hop (nginx / the container platform's load balancer).
//
// This MUST be right, because req.ip is now the key for the auth and OTP rate
// limiters and for the per-IP OTP quota (see clientIp in controllers/user/_helpers.js,
// which was narrowed to req.ip precisely so a caller-supplied X-Forwarded-For
// could not forge it). If Express does not trust the proxy, req.ip resolves to
// the proxy's own address for EVERY request — so every user on the platform
// shares one rate-limit bucket and the limiters lock everybody out at once.
//
// This used to be gated on NODE_ENV === 'production'. That made a security-
// and availability-critical setting depend on one env var being spelled exactly
// right in the deployed environment, with a silent, total-lockout failure mode
// if it was not. It is now on by default and must be turned off explicitly,
// which is the safe direction for a service that is always deployed behind a
// proxy. Set TRUST_PROXY=false only when running with no proxy in front.
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);

// Apply general rate limiting to all routes (but not to OPTIONS)
app.use((req, res, next) => {
        if (req.method === 'OPTIONS') {
                return next();
        }
        generalRateLimit(req, res, next);
});

// Health check endpoint for monitoring
app.get('/', healthCheckRateLimit, (req, res) => {
        res.status(200).json({
                message: 'FinderNate Backend API is running!',
                status: 'healthy',
                timestamp: new Date().toISOString(),
                port: process.env.PORT || 3000,
                host: req.get('host')
        });
});

// Debug endpoint - Only available in development
if (process.env.NODE_ENV === 'development') {
        app.get('/debug', (req, res) => {
                res.status(200).json({
                        message: 'Debug endpoint working',
                        port: process.env.PORT || 3000,
                        env: process.env.NODE_ENV,
                        timestamp: new Date().toISOString()
                });
        });
}

app.get('/health', healthCheckRateLimit, async (req, res) => {
        try {
                const redisStatus = await redisHealthCheck();
                const memoryUsage = process.memoryUsage();
                const cpuUsage = process.cpuUsage();

                res.status(200).json({
                        status: 'healthy',
                        uptime: process.uptime(),
                        timestamp: new Date().toISOString(),
                        services: {
                                redis: redisStatus ? 'connected' : 'disconnected'
                        },
                        system: {
                                memory: {
                                        used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
                                        total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
                                        external: Math.round(memoryUsage.external / 1024 / 1024) + 'MB'
                                },
                                cpu: {
                                        user: cpuUsage.user,
                                        system: cpuUsage.system
                                },
                                platform: process.platform,
                                nodeVersion: process.version,
                                pid: process.pid
                        }
                });
        } catch (error) {
                res.status(503).json({
                        status: 'unhealthy',
                        error: error.message,
                        timestamp: new Date().toISOString()
                });
        }
});

// API v1 health endpoint
app.get('/api/v1/health', healthCheckRateLimit, async (req, res) => {
        res.status(200).json({
                success: true,
                message: "Backend is healthy"
        });
});

//import route
import userRouter from './routes/user.routes.js';
import postRouter from './routes/post.routes.js';
import storyRouter from './routes/story.routes.js';
import reelRouter from "./routes/reel.routes.js";
import exploreRouter from "./routes/explore.routes.js";
import businessRouter from "./routes/business.routes.js";
import chatRouter from "./routes/chat.routes.js";
import mediaRouter from "./routes/media.routes.js";
import suggestedForYouRouter from "./routes/suggestedForYou.routes.js";
import trendingBusinessOwnersRouter from "./routes/trendingBusinessOwners.routes.js";
import contactRequestRouter from "./routes/contactRequest.routes.js";
import notificationRouter from "./routes/notification.routes.js";
import pushNotificationRouter from "./routes/pushNotification.routes.js";
import callRouter from "./routes/call.routes.js";
import subscriptionRouter from "./routes/subscription.routes.js";
import webhookRouter from "./routes/webhook.routes.js";
import adminRouter from "./routes/admin.routes.js";
import feedbackRouter from "./routes/feedback.routes.js";
import qrRouter from "./routes/qr.routes.js";
import streamRouter from "./routes/stream.routes.js";
import shareRouter from "./routes/share.routes.js";
import paymentRouter from "./routes/payment.routes.js";
import boostRouter from "./routes/boost.routes.js";
import orderRouter from "./routes/order.routes.js";
import invoiceRouter from "./routes/invoice.routes.js";
import legalRouter from "./routes/legal.routes.js";



app.use("/api/v1/users", userRouter);
app.use("/api/v1/posts", postRouter);
app.use("/api/v1/stories", storyRouter);
app.use("/api/v1/reels", reelRouter);
app.use("/api/v1/explore", exploreRouter);
app.use("/api/v1/business", businessRouter);
app.use("/api/v1/chats", chatRouter);
app.use("/api/v1/media", mediaRouter);
app.use("/api/v1/suggestions", suggestedForYouRouter);
app.use("/api/v1/business-owners", trendingBusinessOwnersRouter);
app.use("/api/v1/contact-requests", contactRequestRouter);
app.use("/api/v1/notifications", notificationRouter);
app.use("/api/v1/push", pushNotificationRouter);
app.use("/api/v1/calls", callRouter);
app.use("/api/v1/subscription", subscriptionRouter);
app.use("/api/v1/webhooks", webhookRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/feedback", feedbackRouter);
app.use("/api/v1/qr", qrRouter);
app.use("/api/v1/stream", streamRouter);
app.use("/api/v1/share", shareRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/boosts", boostRouter);
app.use("/api/v1/orders", orderRouter);
app.use("/api/v1/invoices", invoiceRouter);
app.use("/api/v1/legal", legalRouter);

app.use(errorHandler);

export { app };
