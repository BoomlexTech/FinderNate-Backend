import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

// ─────────────────────────────────────────────────────────────────────────────
// Google Play Developer API — subscription purchase lookup + acknowledgement.
//
// Called with a purchase token from the app. Everything we then trust about a
// purchase (which product, whether it is actually paid, when it expires, whose
// account it belongs to) comes from THIS lookup and never from the client, the
// same rule the Cashfree path follows.
//
// Auth is a Google Cloud service account that has been granted access in Play
// Console under Users and permissions, with the "View financial data" and
// "Manage orders and subscriptions" permissions. The service account also has
// to be linked to the Play developer account via the Google Cloud project bound
// in Play Console > Setup > API access; without that link every call 401s with
// "The current user has insufficient permissions", which reads like a scope
// problem but is not.
//
// Talking to the REST endpoint directly through axios rather than pulling in
// `googleapis`: that package ships every Google API surface and is enormous,
// and we need exactly two calls.
// ─────────────────────────────────────────────────────────────────────────────

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

export const PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.findernate.app';

/**
 * Service-account credentials, as JSON.
 *
 * Accepts either GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (the raw JSON, optionally
 * base64-encoded — a single-line base64 blob survives .env files and CI secret
 * stores that mangle embedded newlines in the private key) or
 * GOOGLE_PLAY_SERVICE_ACCOUNT_FILE (a path on disk).
 */
const readCredentials = () => {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (raw && raw.trim()) {
        const text = raw.trim().startsWith('{')
            ? raw
            : Buffer.from(raw, 'base64').toString('utf8');
        return JSON.parse(text);
    }
    return null;
};

let authClientPromise = null;

const getAuthClient = () => {
    if (authClientPromise) return authClientPromise;

    const credentials = readCredentials();
    const keyFile = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;

    if (!credentials && !keyFile) {
        throw new Error(
            'Google Play credentials are not configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ' +
            '(raw or base64 service-account JSON) or GOOGLE_PLAY_SERVICE_ACCOUNT_FILE.'
        );
    }

    const auth = new GoogleAuth({
        scopes: [ANDROID_PUBLISHER_SCOPE],
        ...(credentials ? { credentials } : { keyFile })
    });

    authClientPromise = auth.getClient();
    return authClientPromise;
};

/** True when the server is configured to talk to Play at all. */
export const isGooglePlayConfigured = () =>
    Boolean(
        (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim() ||
        (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE || '').trim()
    );

const authorizedHeaders = async () => {
    const client = await getAuthClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Could not obtain a Google Play access token');
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
};

/**
 * purchases.subscriptionsv2.get — the authoritative state of one subscription.
 *
 * v2 rather than the older `purchases.subscriptions`: v1 is keyed by
 * (subscriptionId, token) and cannot describe a subscription with multiple base
 * plans or offers, and Google has it on a deprecation path. v2 is keyed by the
 * token alone, which also means we do not have to trust the client's claim
 * about which product it bought — the response tells us.
 *
 * Shape we care about:
 *   subscriptionState: SUBSCRIPTION_STATE_ACTIVE | _IN_GRACE_PERIOD |
 *                      _CANCELED | _EXPIRED | _ON_HOLD | _PAUSED | _PENDING |
 *                      _PENDING_PURCHASE_CANCELED
 *   lineItems[]:       { productId, expiryTime, latestSuccessfulOrderId (the
 *                        receipt id — our replay key), autoRenewingPlan?,
 *                        deferredItemReplacement? { productId } — a downgrade
 *                        Play has scheduled for the end of the period }
 *   linkedPurchaseToken: the token this purchase REPLACES (an upgrade, a
 *                      downgrade, or a re-signup of a cancelled subscription)
 *   canceledStateContext.replacementCancellation: set on the OLD token once a
 *                      new subscription has replaced it
 *   externalAccountIdentifiers.obfuscatedExternalAccountId:
 *                      the value the app passed at purchase time — our userId
 *   acknowledgementState: ACKNOWLEDGEMENT_STATE_PENDING | _ACKNOWLEDGED
 */
export const getSubscriptionPurchase = async (purchaseToken) => {
    const headers = await authorizedHeaders();
    const url = `${API_ROOT}/applications/${encodeURIComponent(PLAY_PACKAGE_NAME)}` +
                `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const { data } = await axios.get(url, { headers, timeout: 15000 });
    return data;
};

/**
 * Tells Play we have granted what the user paid for.
 *
 * This is not bookkeeping — Google AUTO-REFUNDS and revokes any subscription
 * that is still unacknowledged after three days. It runs server-side rather
 * than relying on the client's completePurchase() so that a user whose app was
 * killed right after paying still keeps the subscription they paid for.
 *
 * Acknowledging twice is harmless; Play answers 400 with
 * "The subscription purchase is already acknowledged", which the caller treats
 * as success.
 */
export const acknowledgeSubscription = async ({ subscriptionId, purchaseToken }) => {
    const headers = await authorizedHeaders();
    const url = `${API_ROOT}/applications/${encodeURIComponent(PLAY_PACKAGE_NAME)}` +
                `/purchases/subscriptions/${encodeURIComponent(subscriptionId)}` +
                `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    try {
        await axios.post(url, {}, { headers, timeout: 15000 });
        return { acknowledged: true, alreadyAcknowledged: false };
    } catch (error) {
        const message = error?.response?.data?.error?.message || '';
        if (error?.response?.status === 400 && /already acknowledged/i.test(message)) {
            return { acknowledged: true, alreadyAcknowledged: true };
        }
        throw error;
    }
};
