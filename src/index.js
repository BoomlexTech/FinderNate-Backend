import 'dotenv/config';
import connectDB from './db/index.js';
import { app } from './app.js';
import http from 'http';
import socketManager from './config/socket.js';
import './config/firebase-admin.config.js'; // Initialize Firebase Admin on startup
import { startSubscriptionExpiryJob } from './jobs/subscriptionExpiry.job.js';
import { ensureCollections } from './services/typesense/index.js';
import { startShareSyncJob } from './jobs/shareSync.job.js';
import { startStoryExpiryJob } from './jobs/storyExpiry.job.js';
import { startBinPurgeJob } from './jobs/binPurge.job.js';
import { startTrendingJobs } from './jobs/trending.job.js';
import { startEmailDigestJob } from './jobs/emailDigest.job.js';
import { startChatExpiryJob } from './jobs/chatExpiry.job.js';
import { startPhase4Jobs } from './jobs/phase4.job.js';
import { startPhase5Jobs } from './jobs/phase5.job.js';
import { startCreatorWorker } from './queues/creatorQueue.js';
import { startLikeWorker } from './queues/likeQueue.js';
// import { seedLikesToRedis } from './scripts/seedLikesToRedis.js';
import { redisClient } from './config/redis.config.js';
import { startCacheWarmer } from './utils/cacheWarmer.utils.js';



// Global error handlers to catch unhandled errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        return;
    }
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('🚫 Unhandled Rejection:', error);
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
        return;
    }
    process.exit(1);
});

const server = http.createServer(app);

// Node closes any request still in flight after 5 minutes by default, which is
// far too short for the 600 MB upload cap: at a realistic mobile 2 Mbps a
// full-size video takes roughly 40 minutes to send. The socket was destroyed
// mid-upload and the client only saw a generic network failure.
// headersTimeout (60s, unchanged) stays well below this and remains the guard
// against a client dribbling out its headers.
server.requestTimeout = 60 * 60 * 1000; // 1 hour

// Connect to MongoDB, then start the server
connectDB()
    .then(async () => {

        // Ensure Typesense collections exist (non-fatal — search falls back to Mongo).
        try {
            await ensureCollections();
        } catch (err) {
            console.error('⚠️  Typesense ensureCollections failed (continuing without it):', err.message);
        }

        // Initialize Socket.IO with our enhanced manager after DB connection
        try {
            await socketManager.initialize(server);
        } catch (error) {
            console.error('❌ Socket.IO initialization error:', error);
            throw error;
        }

        const PORT = process.env.PORT || 3000;

        // Seed Redis with DB like state once — cron keeps it in sync after that.
        // Key has no TTL so it persists until Redis is flushed/restarted.
        // redisClient.get('fn:redis:likes:seeded').then(seeded => {
        //     if (!seeded) {
        //         seedLikesToRedis()
        //             .then(() => redisClient.set('fn:redis:likes:seeded', '1'))
        //             .catch(err => console.error('❌ Redis like seed failed:', err));
        //     }
        // });

        const warmerSubscriber = startCacheWarmer();

        server.listen(PORT, '0.0.0.0', () => {

            // Start cron jobs and queue workers
            startSubscriptionExpiryJob();
            startShareSyncJob();
            startStoryExpiryJob();
            // Phase 2
            startBinPurgeJob();
            startTrendingJobs();
            startEmailDigestJob();
            startChatExpiryJob();
            startPhase4Jobs();
            startPhase5Jobs();
            startCreatorWorker().catch((e) => console.error('[creator] worker did not start:', e?.message || e));
            startLikeWorker();
        });

        server.on('close', () => warmerSubscriber.quit());

        server.on('error', (error) => {
            console.error('❌ Server error:', error);
            process.exit(1);
        });

        // ── Graceful shutdown ────────────────────────────────────────────────
        //
        // Without this, the container platform's SIGTERM killed the process
        // outright, so EVERY routine deploy severed whatever was in flight —
        // including a Cashfree verification that had already charged the card
        // but had not yet bound the transaction to the order. The payment
        // succeeds at the gateway and the order stays 'pending' forever, which
        // is the hardest class of failure to reconcile after the fact.
        //
        // Stop accepting new connections, let the in-flight ones finish, then
        // exit. The timeout is a backstop: if something will not drain we still
        // have to go before the platform's own SIGKILL lands (usually 30s), and
        // exiting a little early is better than being killed mid-write.
        const SHUTDOWN_GRACE_MS = 15_000;
        let shuttingDown = false;

        const shutdown = (signal) => {
            // A second signal must not start a second drain.
            if (shuttingDown) return;
            shuttingDown = true;
            console.log(`⏻ ${signal} received — draining in-flight requests…`);

            const forced = setTimeout(() => {
                console.error('⏻ Drain timed out — exiting anyway.');
                process.exit(0);
            }, SHUTDOWN_GRACE_MS);
            // Do not let this timer alone hold the process open.
            forced.unref();

            server.close((err) => {
                if (err) console.error('⏻ Error while closing server:', err);
                clearTimeout(forced);
                console.log('⏻ Drained cleanly.');
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
        console.error("❌ MONGODB connection error:", err);
        process.exit(1);
    });
