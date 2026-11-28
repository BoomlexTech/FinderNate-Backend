import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PAID_TIERS, TIER_NAMES, TIER_RANK, PLAN_LIMITS, CALLING_TIERS,
    tierRank, tierHasCalling, buildPostLimitError, buildProductLimitError,
} from '../../src/utils/planLimits.js';
import {
    SUBSCRIPTION_PLANS, PLAY_PRODUCT_TO_PLAN, PLAN_TO_PLAY_PRODUCT, buildPlanCatalog, planFromOrderNote,
} from '../../src/controllers/subscription/plans.js';
import { PLAN_TO_BUSINESS_PLAN, planRank, planChangeMessage } from '../../src/controllers/subscription/activation.js';
import { badgeForPlan } from '../../src/constants/subscriptionBadges.js';
import { PAID_PLANS, PREMIUM_PLANS, TIERS, visibilityTier } from '../../src/utils/phase4.rules.js';
import { tierAtLeast, getLockedSections } from '../../src/controllers/business/insightsHelpers.js';
import { priorityForTier } from '../../src/utils/supportQueue.utils.js';
import { ENHANCE_DEFAULT_LIMITS } from '../../src/utils/phase5.rules.js';
import {
    readSignupOtpMethod, requestedSignupOtpMethod, resendSignupOtpMethod, verifiedFlagsFor,
} from '../../src/utils/signupOtp.rules.js';
import { assertContactsVerifiedForBusiness } from '../../src/controllers/business/switch.js';
import { hasBlueTick, isPlusActive } from '../../src/utils/plusBadge.js';
import {
    readHideAddress, withoutStreetAddress, splitServiceAddress, publicServicePlace,
} from '../../src/utils/serviceAddress.utils.js';
import { validateDeliveryAndLocation, deliveryOptionsForServiceType } from '../../src/utils/deliveryValidation.js';
import {
    parseVersion, compareVersions, needsUpdate, updateNotificationText, PLAY_STORE_URL,
} from '../../src/utils/appVersion.utils.js';
import Subscription from '../../src/models/subscription.models.js';
import Business from '../../src/models/business.models.js';
import Order from '../../src/models/order.models.js';
import Post from '../../src/models/userPost.models.js';

// Client list "Improvements" (28 Nov 2026).

// ── 8: Basic ₹9, Pro ₹19, Premium ₹29, each with its own badge ──────────────

test('#8 three paid plans at ₹9, ₹19 and ₹29, cheapest first', () => {
    assert.deepEqual(PAID_TIERS, ['basic', 'small_business', 'corporate']);
    assert.equal(SUBSCRIPTION_PLANS.basic.price, 9);
    assert.equal(SUBSCRIPTION_PLANS.small_business.price, 19);
    assert.equal(SUBSCRIPTION_PLANS.corporate.price, 29);
    assert.equal(SUBSCRIPTION_PLANS.free.price, 0);
});

test('#8 the plans are called Basic, Pro and Premium everywhere', () => {
    assert.equal(TIER_NAMES.basic, 'Basic');
    assert.equal(TIER_NAMES.small_business, 'Pro');
    assert.equal(TIER_NAMES.corporate, 'Premium');
    for (const id of PAID_TIERS) assert.equal(SUBSCRIPTION_PLANS[id].name, TIER_NAMES[id]);
    const names = buildPlanCatalog().map((plan) => plan.name);
    assert.deepEqual(names, ['Free', 'Basic', 'Pro', 'Premium']);
    // The old names are gone from what people read.
    const text = JSON.stringify(buildPlanCatalog());
    assert.equal(/Small Business|Corporate/.test(text), false);
});

test('#8 the plan cards show the price, the benefits and the plan\'s own badge', () => {
    const [free, basic, pro, premium] = buildPlanCatalog();
    assert.equal(basic.price, '₹9');
    assert.equal(pro.price, '₹19');
    assert.equal(premium.price, '₹29');
    for (const plan of [basic, pro, premium]) {
        assert.ok(plan.features.length >= 5, `${plan.name} lists its benefits`);
        assert.equal(plan.period, 'per month');
        assert.equal(plan.badge.label, plan.name);
        assert.ok(plan.features.some((feature) => feature.includes(`${plan.name} badge`)));
    }
    assert.equal(free.badge, null);
    // Numbers in the copy come from the limits that are enforced.
    assert.ok(basic.features.includes(`Up to ${PLAN_LIMITS.basic.postsPerMonth} posts per month`));
    assert.ok(basic.limitations.includes('No audio or video calling'));
    assert.ok(pro.features.includes('Audio and video calling'));
});

test('#8 every plan has a different badge, and none of them is the blue tick', () => {
    const badges = PAID_TIERS.map(badgeForPlan);
    assert.equal(new Set(badges.map((b) => b.label)).size, 3);
    assert.equal(new Set(badges.map((b) => b.color)).size, 3);
    assert.deepEqual(badges.map((b) => b.type), PAID_TIERS);
    assert.equal(badgeForPlan('free'), null);
    assert.equal(badgeForPlan('nonsense'), null);
    // A copy, so a response can be edited without changing the palette.
    badgeForPlan('basic').label = 'changed';
    assert.equal(badgeForPlan('basic').label, 'Basic');
});

test('#8 Free < Basic < Pro < Premium, and an unknown plan counts as Free', () => {
    assert.deepEqual(TIER_RANK, { free: 0, basic: 1, small_business: 2, corporate: 3 });
    assert.ok(tierRank('basic') > tierRank('free'));
    assert.ok(tierRank('small_business') > tierRank('basic'));
    assert.ok(tierRank('corporate') > tierRank('small_business'));
    assert.equal(tierRank('whatever'), 0);
    assert.equal(planRank('basic'), 1);
    assert.equal(planRank(undefined), 0);
});

test('#8 moving down a plan is a switch, moving up is an upgrade', () => {
    assert.match(planChangeMessage({ planName: 'Basic', plan: 'basic', previousPlan: 'small_business' }), /switched to Basic/);
    assert.match(planChangeMessage({ planName: 'Pro', plan: 'small_business', previousPlan: 'basic' }), /upgraded to Pro/);
    assert.match(planChangeMessage({ planName: 'Basic', plan: 'basic', previousPlan: null }), /upgraded to Basic/);
});

test('#8 Basic gives the badge and public posts; calling, boosts and analytics start at Pro', () => {
    assert.deepEqual(CALLING_TIERS, ['small_business', 'corporate']);
    assert.equal(tierHasCalling('basic'), false);
    assert.equal(tierHasCalling('free'), false);
    assert.equal(tierHasCalling('small_business'), true);
    assert.equal(tierHasCalling('corporate'), true);

    assert.equal(PLAN_LIMITS.basic.boost, null);
    assert.ok(PLAN_LIMITS.small_business.boost);

    assert.equal(tierAtLeast('basic', 'small_business'), false);
    assert.equal(tierAtLeast('small_business', 'small_business'), true);
    assert.equal(getLockedSections('basic').length, getLockedSections('free').length);

    assert.equal(priorityForTier('basic').priority, 'standard');
    assert.equal(priorityForTier('small_business').priority, 'priority');
    assert.equal(priorityForTier('corporate').priority, 'dedicated');
});

test('#8 Basic sits between Free and Pro on every limit', () => {
    const { free, basic, small_business: pro } = PLAN_LIMITS;
    assert.ok(basic.postsPerMonth > free.postsPerMonth);
    assert.equal(pro.postsPerMonth, null);
    assert.ok(basic.productCatalog > free.productCatalog && basic.productCatalog < pro.productCatalog);
    assert.ok(basic.insightsMaxDays > free.insightsMaxDays && basic.insightsMaxDays < pro.insightsMaxDays);
    assert.ok(ENHANCE_DEFAULT_LIMITS.basic > ENHANCE_DEFAULT_LIMITS.free);
    assert.ok(ENHANCE_DEFAULT_LIMITS.basic < ENHANCE_DEFAULT_LIMITS.small_business);
});

test('#8 a Basic business is a paid business: its posts reach everyone once verified', () => {
    assert.equal(PLAN_TO_BUSINESS_PLAN.basic, 'basic');
    assert.equal(PLAN_TO_BUSINESS_PLAN.small_business, 'plan2');
    assert.equal(PLAN_TO_BUSINESS_PLAN.corporate, 'plan3');
    assert.ok(PAID_PLANS.has('basic'));
    assert.equal(PREMIUM_PLANS.has('basic'), false);
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'basic', subscriptionStatus: 'active' }), TIERS.PUBLIC);
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan3', subscriptionStatus: 'active' }), TIERS.PREMIUM);
    assert.equal(visibilityTier({ kycStatus: 'verified', plan: 'plan1', subscriptionStatus: 'active' }), TIERS.NETWORK);
    assert.equal(visibilityTier({ kycStatus: 'pending', plan: 'basic', subscriptionStatus: 'active' }), TIERS.HIDDEN);
});

test('#8 the data model takes the new plan', () => {
    assert.ok(Subscription.schema.path('plan').enumValues.includes('basic'));
    assert.ok(Subscription.schema.path('pendingPlan').enumValues.includes('basic'));
    assert.ok(Business.schema.path('plan').enumValues.includes('basic'));
    // The ids of Pro and Premium did not change: rows written before still load.
    assert.ok(Subscription.schema.path('plan').enumValues.includes('small_business'));
    assert.ok(Subscription.schema.path('plan').enumValues.includes('corporate'));
});

test('#8 Google Play: Basic is a product of its own; Pro and Premium keep their product ids', () => {
    assert.deepEqual(PLAY_PRODUCT_TO_PLAN, { basic: 'basic', small_business: 'small_business', corporate: 'corporate' });
    assert.equal(PLAN_TO_PLAY_PRODUCT.basic, 'basic');
});

test('#8 a Cashfree order is matched to its plan by the name on it', () => {
    assert.equal(planFromOrderNote('FinderNate Basic Subscription', 9), 'basic');
    assert.equal(planFromOrderNote('FinderNate Pro Subscription', 19), 'small_business');
    assert.equal(planFromOrderNote('FinderNate Premium Subscription', 29), 'corporate');
    // The name wins over the amount.
    assert.equal(planFromOrderNote('FinderNate Premium Subscription', 9), 'corporate');
    // No usable note: the amount, when it names exactly one plan.
    assert.equal(planFromOrderNote('', 9), 'basic');
    assert.equal(planFromOrderNote(undefined, 19), 'small_business');
    assert.equal(planFromOrderNote('', 500), null);
});

test('#8 an order paid under the old plan names is still recognised', () => {
    assert.equal(planFromOrderNote('FinderNate Small Business Subscription', 19), 'small_business');
    // Old Corporate price: no plan costs ₹999 today, the name still places it.
    assert.equal(planFromOrderNote('FinderNate Corporate Subscription', 999), 'corporate');
});

test('#8 limit messages name the right plans', () => {
    const resetsAt = new Date('2026-12-01T00:00:00+05:30');
    const basicFull = buildPostLimitError({ tier: 'basic', limit: 30, used: 30, remaining: 0, resetsAt });
    assert.match(basicFull.message, /on the Basic plan/);
    assert.match(basicFull.message, /Upgrade to Pro for unlimited posts/);
    assert.deepEqual(basicFull.errors.availablePlans, ['small_business', 'corporate']);

    const freeFull = buildPostLimitError({ tier: 'free', limit: 10, used: 10, remaining: 0, resetsAt });
    assert.match(freeFull.message, /on the Free plan/);
    assert.deepEqual(freeFull.errors.availablePlans, PAID_TIERS);

    const freeCatalog = buildProductLimitError({ tier: 'free', limit: 10, used: 10, remaining: 0 });
    assert.equal(freeCatalog.errors.upgradeTo, 'basic');
    assert.match(freeCatalog.message, /upgrade to Basic to list up to 25/);
    const basicCatalog = buildProductLimitError({ tier: 'basic', limit: 25, used: 25, remaining: 0 });
    assert.equal(basicCatalog.errors.upgradeTo, 'small_business');
    const proCatalog = buildProductLimitError({ tier: 'small_business', limit: 50, used: 50, remaining: 0 });
    assert.equal(proCatalog.errors.upgradeTo, 'corporate');
    assert.match(proCatalog.message, /upgrade to Premium for an unlimited catalogue/);
});

// ── 3: sign-up code by SMS or by email ───────────────────────────────────────

test('#3 the sign-up code goes by SMS unless the person asks for email', () => {
    assert.equal(readSignupOtpMethod({}), 'phone');
    assert.equal(readSignupOtpMethod(undefined), 'phone');
    assert.equal(readSignupOtpMethod({ otpMethod: 'email' }), 'email');
    assert.equal(readSignupOtpMethod({ otpMethod: ' EMAIL ' }), 'email');
    assert.equal(readSignupOtpMethod({ otpMethod: 'phone' }), 'phone');
    assert.equal(readSignupOtpMethod({ otpMethod: 'sms' }), 'phone');
    assert.equal(readSignupOtpMethod({ verifyVia: 'email' }), 'email');
    // Anything unknown is the old behaviour, not an error: older builds send nothing.
    assert.equal(readSignupOtpMethod({ otpMethod: 'carrier-pigeon' }), 'phone');
    assert.equal(requestedSignupOtpMethod({ otpMethod: 'carrier-pigeon' }), null);
});

test('#3 a resend repeats the channel the sign-up started with, or switches when asked', () => {
    assert.equal(resendSignupOtpMethod({}, 'email'), 'email');
    assert.equal(resendSignupOtpMethod({}, 'phone'), 'phone');
    assert.equal(resendSignupOtpMethod({}, undefined), 'phone');
    assert.equal(resendSignupOtpMethod({ otpMethod: 'email' }, 'phone'), 'email');
    assert.equal(resendSignupOtpMethod({ otpMethod: 'phone' }, 'email'), 'phone');
});

test('#3 only the channel the code arrived on counts as verified', () => {
    assert.deepEqual(verifiedFlagsFor('phone'), { isPhoneVerified: true, isEmailVerified: false });
    assert.deepEqual(verifiedFlagsFor('email'), { isPhoneVerified: false, isEmailVerified: true });
});

// ── 4: both verified before switching to business ───────────────────────────

const gate = (user) => {
    try {
        assertContactsVerifiedForBusiness(user);
        return null;
    } catch (error) {
        return error;
    }
};

test('#4 a personal account needs its email AND its mobile number verified to become a business', () => {
    assert.equal(gate({ isBusinessProfile: false, isEmailVerified: true, isPhoneVerified: true }), null);

    const noEmail = gate({ isBusinessProfile: false, isEmailVerified: false, isPhoneVerified: true });
    assert.equal(noEmail.statusCode, 403);
    assert.equal(noEmail.message, 'Verify your email address before switching to a business account.');
    // An object, not a list: the app reads a 403 with a LIST of errors as the legal gate.
    assert.deepEqual(noEmail.errors, { errorCode: 'VERIFICATION_REQUIRED', emailVerified: false, phoneVerified: true });

    const noPhone = gate({ isBusinessProfile: false, isEmailVerified: true, isPhoneVerified: false });
    assert.equal(noPhone.message, 'Verify your mobile number before switching to a business account.');
    assert.deepEqual(noPhone.errors, { errorCode: 'VERIFICATION_REQUIRED', emailVerified: true, phoneVerified: false });

    const neither = gate({ isBusinessProfile: false });
    assert.equal(neither.message, 'Verify your email address and mobile number before switching to a business account.');
});

test('#4 an account that is already a business is not locked out', () => {
    assert.equal(gate({ isBusinessProfile: true, isEmailVerified: false, isPhoneVerified: false }), null);
    assert.equal(gate(null), null);
});

// ── 7: Findernate Plus gives the blue tick ──────────────────────────────────

test('#7 an active Findernate Plus shows the blue tick, and it goes when Plus ends', () => {
    const now = new Date('2026-11-28T10:00:00Z');
    const tomorrow = new Date('2026-11-29T10:00:00Z');
    const yesterday = new Date('2026-11-27T10:00:00Z');

    assert.equal(isPlusActive({ plusUntil: tomorrow }, now), true);
    assert.equal(isPlusActive({ plusUntil: yesterday }, now), false);
    assert.equal(isPlusActive({ plusUntil: null }, now), false);
    assert.equal(isPlusActive(null, now), false);

    // Active Plus: the tick shows even before the stored flag catches up.
    assert.equal(hasBlueTick({ plusUntil: tomorrow, isBlueTickVerified: false }, now), true);
    // Plus ended and the tick came with it: gone at once, whatever is stored.
    assert.equal(hasBlueTick({ plusUntil: yesterday, isBlueTickVerified: true, blueTickFromPlus: true }, now), false);
    // No Plus, no tick.
    assert.equal(hasBlueTick({ plusUntil: null, isBlueTickVerified: false }, now), false);
});

test('#7 a tick an admin granted does not depend on Findernate Plus', () => {
    const now = new Date('2026-11-28T10:00:00Z');
    const yesterday = new Date('2026-11-27T10:00:00Z');
    assert.equal(hasBlueTick({ isBlueTickVerified: true, blueTickFromPlus: false }, now), true);
    assert.equal(hasBlueTick({ plusUntil: yesterday, isBlueTickVerified: true, blueTickFromPlus: false }, now), true);
});

// ── 26: service address optional, and hideable ──────────────────────────────

test('#26 "hide address" is read from a JSON body and from a form post', () => {
    assert.equal(readHideAddress({ hideAddress: true }), true);
    assert.equal(readHideAddress({ hideAddress: 'true' }), true);
    assert.equal(readHideAddress({ hideAddress: false }), false);
    assert.equal(readHideAddress({ hideAddress: 'false' }), false);
    assert.equal(readHideAddress({}), false);
    assert.equal(readHideAddress(undefined), false);
});

test('#26 a hidden address never reaches the post: no street, no postcode, no map point', () => {
    const location = {
        name: 'Trichy', address: '12 Gandhi Road', city: 'Trichy', state: 'Tamil Nadu', country: 'India',
        postalCode: '620001', coordinates: { type: 'Point', coordinates: [78.7, 10.79] },
    };
    const split = splitServiceAddress({ name: 'Home tuition', hideAddress: true }, location);

    assert.equal(split.hideAddress, true);
    assert.equal(split.privateAddress, '12 Gandhi Road');
    assert.deepEqual(split.location, { name: 'Trichy', city: 'Trichy', state: 'Tamil Nadu', country: 'India' });
    assert.equal(split.service.hideAddress, true);
    // Nothing that is stored publicly still holds it.
    assert.equal(JSON.stringify([split.service, split.location]).includes('Gandhi'), false);
    assert.equal(JSON.stringify([split.service, split.location]).includes('620001'), false);
    // The caller's object is not changed under it.
    assert.equal(location.address, '12 Gandhi Road');
});

test('#26 a location nested inside the service details is stripped too', () => {
    const split = splitServiceAddress(
        { hideAddress: 'true', location: { address: '7 Lake View', city: 'Ooty', coordinates: { type: 'Point', coordinates: [76.7, 11.4] } } },
        undefined,
    );
    assert.equal(split.privateAddress, '7 Lake View');
    assert.deepEqual(split.service.location, { city: 'Ooty' });
    assert.equal(split.location, undefined);
});

test('#26 an address that is not hidden is stored as it was sent', () => {
    const location = { name: 'Trichy', address: '12 Gandhi Road', city: 'Trichy' };
    const split = splitServiceAddress({ name: 'Home tuition' }, location);
    assert.equal(split.hideAddress, false);
    assert.equal(split.privateAddress, '');
    assert.equal(split.location, location);
    assert.equal(split.service.hideAddress, false);
});

test('#26 no service details stays no service details', () => {
    assert.equal(splitServiceAddress(undefined, undefined).service, undefined);
    assert.equal(splitServiceAddress(null, { city: 'Pune' }).service, null);
});

test('#26 the checkout card never names a hidden address', () => {
    const location = { name: 'Near the temple', address: '12 Gandhi Road', city: 'Trichy', state: 'Tamil Nadu' };
    assert.equal(publicServicePlace({ location }), 'Near the temple');
    assert.equal(publicServicePlace({ hideAddress: true, location }), 'Trichy');
    assert.equal(publicServicePlace({ hideAddress: true, location: { address: '12 Gandhi Road' } }), '');
    assert.equal(publicServicePlace({}), '');
    assert.equal(withoutStreetAddress(null), null);
});

test('#26 the service schema records the choice and keeps old charges working', () => {
    const service = Post.schema.path('customization.service').schema;
    assert.ok(service.path('hideAddress'));
    assert.equal(service.path('hideAddress').options.default, false);
    assert.ok(service.path('additionalCharges'), 'old service posts still carry their extra charge');
});

// ── 25 / 27: no "online, offline or both" on a service; location optional ───

test('#25 a service post no longer has to say online, offline or both', async () => {
    assert.equal(deliveryOptionsForServiceType('in-person'), 'offline');
    assert.equal(deliveryOptionsForServiceType('hybrid'), 'both');
    assert.equal(deliveryOptionsForServiceType('online'), 'online');
    assert.equal(deliveryOptionsForServiceType(undefined), 'online');

    const inPerson = await validateDeliveryAndLocation({ name: 'Haircut', serviceType: 'in-person', location: undefined }, 'service');
    assert.equal(inPerson.deliveryOptions, 'offline');
    const hybrid = await validateDeliveryAndLocation({ name: 'Coaching', serviceType: 'hybrid', location: undefined }, 'service');
    assert.equal(hybrid.deliveryOptions, 'both');
    // An older app still sends its own choice, and it is kept.
    const older = await validateDeliveryAndLocation({ name: 'Coaching', serviceType: 'hybrid', deliveryOptions: 'online', location: undefined }, 'service');
    assert.equal(older.deliveryOptions, 'online');
});

test('#27 product, service and business posts need no location', async () => {
    for (const type of ['product', 'service', 'business']) {
        for (const deliveryOptions of ['offline', 'both', 'online']) {
            const details = await validateDeliveryAndLocation({ name: 'x', deliveryOptions, location: undefined }, type);
            assert.equal(details.deliveryOptions, deliveryOptions);
            assert.equal(details.location, undefined);
        }
    }
    // A location that already has its map point is kept as it is.
    const coordinates = { type: 'Point', coordinates: [78.7, 10.79] };
    const placed = await validateDeliveryAndLocation({ name: 'x', deliveryOptions: 'offline', location: { name: 'Trichy', coordinates } }, 'product');
    assert.deepEqual(placed.location, { name: 'Trichy', coordinates });
});

test('#27 the details themselves, and a product\'s delivery option, are still required', async () => {
    await assert.rejects(validateDeliveryAndLocation({ location: undefined }, 'service'), /service details are required/);
    await assert.rejects(validateDeliveryAndLocation({ name: 'x', location: undefined }, 'product'), /Delivery options/);
    await assert.rejects(validateDeliveryAndLocation({ name: 'x', deliveryOptions: 'teleport', location: undefined }, 'product'), /must be 'online', 'offline', or 'both'/);
});

// ── 24: door number and landmark at checkout ────────────────────────────────

test('#24 an order keeps the door number and the landmark', () => {
    const order = new Order({
        shippingAddress: {
            fullName: 'A Buyer', phoneNumber: '9876543210', doorNumber: ' 12/4 ', addressLine1: 'Gandhi Road',
            landmark: ' Opposite the bus stand ', city: 'Trichy', state: 'Tamil Nadu', postalCode: '620001',
        },
    });
    assert.equal(order.shippingAddress.doorNumber, '12/4');
    assert.equal(order.shippingAddress.landmark, 'Opposite the bus stand');
    assert.equal(order.shippingAddress.addressLine1, 'Gandhi Road');
    // Both are optional: an order from an older app has neither.
    const older = new Order({ shippingAddress: { fullName: 'A Buyer', addressLine1: 'Gandhi Road' } });
    assert.equal(older.shippingAddress.doorNumber, undefined);
    assert.equal(older.shippingAddress.landmark, undefined);
});

// ── 14: "update available" ──────────────────────────────────────────────────

test('#14 versions are compared by their numbers, not as text', () => {
    assert.deepEqual(parseVersion('4.9.33'), [4, 9, 33]);
    assert.deepEqual(parseVersion('4.9.33+4093300'), [4, 9, 33]);
    assert.deepEqual(parseVersion('v4.10'), [4, 10]);
    assert.equal(parseVersion('latest'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion(undefined), null);

    assert.equal(compareVersions('4.9.9', '4.9.10'), -1);
    assert.equal(compareVersions('4.10.0', '4.9.33'), 1);
    assert.equal(compareVersions('4.9.33', '4.9.33+4093300'), 0);
    assert.equal(compareVersions('4.9', '4.9.0'), 0);
    assert.equal(compareVersions('5', '4.99.99'), 1);
});

test('#14 only phones on an older version are told about an update', () => {
    assert.equal(needsUpdate('4.9.32', '4.9.33'), true);
    assert.equal(needsUpdate('4.9.33', '4.9.33'), false);
    assert.equal(needsUpdate('4.9.34', '4.9.33'), false);
    // A build from before the app reported its version is older than anything announced now.
    assert.equal(needsUpdate(null, '4.9.33'), true);
    assert.equal(needsUpdate('', '4.9.33'), true);
    // Nothing sensible to update to: nobody is told.
    assert.equal(needsUpdate('4.9.32', 'soon'), false);
});

test('#14 the notification says what to do and where the tap goes', () => {
    const plain = updateNotificationText('4.9.33');
    assert.equal(plain.title, 'Update available');
    assert.equal(plain.body, 'Findernate 4.9.33 is ready. Tap to update from Google Play.');
    const withNotes = updateNotificationText('4.9.33', ' New plans and a faster feed. ');
    assert.equal(withNotes.body, 'Findernate 4.9.33 is ready: New plans and a faster feed. Tap to update.');
    assert.equal(PLAY_STORE_URL, 'https://play.google.com/store/apps/details?id=com.findernate.app');
});
