/**
 * Phase 4 rules (business trust, money and SEO). Pure functions only, so the
 * unit tests can load this file without a database or Redis.
 */

// ─── Business visibility (#74, #78, §5.1) ──────────────────────────────────

export const TIERS = Object.freeze({ HIDDEN: 'hidden', NETWORK: 'network', PUBLIC: 'public', PREMIUM: 'premium' });

export const COMMERCIAL_TYPES = new Set(['product', 'service', 'business']);

/** Business.plan values: plan1 = Free, plan2 = Small Business, plan3 = Corporate (Premium), plan4 = legacy top tier. */
export const PAID_PLANS = new Set(['plan2', 'plan3', 'plan4']);
export const PREMIUM_PLANS = new Set(['plan3', 'plan4']);

/**
 * Who may see a business's product, service and business posts:
 *
 * | KYC not verified          | hidden  (only the business itself)  |
 * | verified, no active plan  | network (followers and following)   |
 * | verified, active plan     | public  (everyone)                  |
 * | verified, Premium plan    | premium (everyone, ranked on top)   |
 */
export const visibilityTier = ({ kycStatus, plan, subscriptionStatus } = {}) => {
    if (kycStatus !== 'verified') return TIERS.HIDDEN;
    const active = subscriptionStatus === 'active' && PAID_PLANS.has(plan);
    if (!active) return TIERS.NETWORK;
    return PREMIUM_PLANS.has(plan) ? TIERS.PREMIUM : TIERS.PUBLIC;
};

/** Can this viewer see a commercial post from an author in `tier`? */
export const canSeeCommercial = (tier, { isOwner = false, isConnected = false } = {}) => {
    if (isOwner) return true;
    if (tier === TIERS.PUBLIC || tier === TIERS.PREMIUM) return true;
    if (tier === TIERS.NETWORK) return isConnected;
    return false;
};

/**
 * KYC status of a business, including businesses your admins approved before
 * Phase 4 (Q10: they count as verified, and get a deadline to complete the
 * automatic check once it's available).
 */
export const effectiveKycStatus = (business, now = new Date()) => {
    if (!business) return 'not_started';
    const kyc = business.kyc || {};
    if (kyc.status === 'verified') {
        if (kyc.recheckDueAt && new Date(kyc.recheckDueAt) < now && kyc.source === 'legacy_admin') return 'recheck_overdue';
        return 'verified';
    }
    if (kyc.status) return kyc.status;
    // Never touched by Phase 4: an admin approval still counts.
    if (business.verificationStatus === 'approved') return 'verified';
    return business.verificationStatus === 'rejected' ? 'rejected' : 'not_started';
};

/** Moves Premium authors' posts to the front, keeping the order otherwise (#78). */
export const premiumFirst = (posts, isPremium) => {
    const top = [];
    const rest = [];
    for (const p of posts || []) (isPremium(p) ? top : rest).push(p);
    return [...top, ...rest];
};

// ─── GSTIN / PAN (#30, #79) ─────────────────────────────────────────────────

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const normalizeId = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');

export const isValidPan = (pan) => PAN_RE.test(normalizeId(pan));

/** Format and checksum check for a GSTIN. */
export const isValidGstin = (gstin) => {
    const g = normalizeId(gstin);
    if (!GSTIN_RE.test(g)) return false;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const v = GST_CHARS.indexOf(g[i]);
        const p = v * (i % 2 === 0 ? 1 : 2);
        sum += Math.floor(p / 36) + (p % 36);
    }
    const check = GST_CHARS[(36 - (sum % 36)) % 36];
    return check === g[14];
};

/** Characters 3–12 of a GSTIN are the holder's PAN. */
export const panFromGstin = (gstin) => normalizeId(gstin).slice(2, 12);

/** The 4th PAN character says who holds it: P person, C company, F firm, … */
export const panHolderType = (pan) => ({ P: 'individual', C: 'company', H: 'huf', F: 'firm', A: 'aop', T: 'trust', B: 'boi', L: 'local_authority', J: 'artificial_person', G: 'government' })[normalizeId(pan)[3]] || 'unknown';

export const maskId = (v, keep = 4) => {
    const s = normalizeId(v);
    return s.length <= keep ? s : `${'•'.repeat(s.length - keep)}${s.slice(-keep)}`;
};

// ─── Name matching (#30) ─────────────────────────────────────────────────────

const NOISE = new Set(['M', 'S', 'MS', 'MESSRS', 'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'CO', 'COMPANY', 'AND', 'THE', 'INDIA', 'ENTERPRISES', 'ENTERPRISE', 'TRADERS', 'TRADING', 'SHRI', 'SRI', 'SMT', 'MR', 'MRS', 'DR', 'OPC']);

export const nameTokens = (name) => String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t));

/** 0–100: how similar two names are, ignoring "Pvt Ltd", "M/s" and the like. */
export const nameMatchScore = (a, b) => {
    const A = new Set(nameTokens(a));
    const B = new Set(nameTokens(b));
    if (!A.size || !B.size) return 0;
    let common = 0;
    for (const t of A) if (B.has(t)) common++;
    // Containment rather than Jaccard: "Asha Foods" vs "Asha Foods Kitchen" matches.
    return Math.round((common / Math.min(A.size, B.size)) * 100);
};

export const NAME_MATCH_THRESHOLD = 70;

/**
 * Decides an automatic KYC result from the checks that ran. Anything that
 * isn't a clean pass goes to the admin queue rather than being rejected.
 */
export const decideKyc = ({ registrationType, gst, pan, aadhaar, businessName }) => {
    const reasons = [];
    if (registrationType === 'registered') {
        if (!gst?.valid) reasons.push('GSTIN could not be verified');
        else if (gst.active === false) reasons.push('GSTIN is not active');
        if (!pan?.valid) reasons.push('PAN could not be verified');
        if (gst?.valid && pan?.valid && gst.pan && normalizeId(gst.pan) !== normalizeId(pan.pan)) reasons.push('PAN does not belong to this GSTIN');
        const gstNames = [gst?.legalName, gst?.tradeName].filter(Boolean);
        const bestGst = gstNames.length ? Math.max(...gstNames.map((n) => nameMatchScore(n, businessName))) : 0;
        if (gst?.valid && bestGst < NAME_MATCH_THRESHOLD) reasons.push('Business name does not match the GST record');
        if (gst?.valid && pan?.valid && pan.name && gst.legalName && nameMatchScore(pan.name, gst.legalName) < NAME_MATCH_THRESHOLD) {
            reasons.push('PAN name does not match the GST legal name');
        }
    } else if (registrationType === 'unregistered') {
        if (!pan?.valid) reasons.push('PAN could not be verified');
        if (!aadhaar?.valid) reasons.push('Aadhaar could not be verified');
        if (pan?.valid && aadhaar?.valid && pan.name && aadhaar.name && nameMatchScore(pan.name, aadhaar.name) < NAME_MATCH_THRESHOLD) {
            reasons.push('PAN and Aadhaar names do not match');
        }
    } else {
        reasons.push('Choose registered or unregistered');
    }
    return reasons.length ? { status: 'needs_review', reasons } : { status: 'verified', reasons: [] };
};

/** Fields a business can't edit once its details are confirmed (#4). */
export const LOCKED_FIELDS = ['businessName', 'businessType', 'registrationType', 'gstNumber', 'panNumber', 'location.address', 'location.city', 'location.state', 'location.postalCode'];

/** Which of the requested changes touch locked fields. */
export const lockedFieldsTouched = (body = {}) => {
    const hits = [];
    for (const f of LOCKED_FIELDS) {
        const [a, b] = f.split('.');
        if (b ? body[a] && typeof body[a] === 'object' && body[a][b] !== undefined : body[a] !== undefined) hits.push(f);
    }
    return hits;
};

// ─── Money (#27, #74, #77, #80) ──────────────────────────────────────────────

export const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Price with GST added on top. */
export const withGst = (amount, gstPercent = 18) => {
    const base = round2(amount);
    const gst = round2((base * (Number(gstPercent) || 0)) / 100);
    return { amount: base, gst, total: round2(base + gst), gstPercent: Number(gstPercent) || 0 };
};

export const adPrice = (days, dailyFee, gstPercent) => withGst(Number(days) * Number(dailyFee), gstPercent);

/** B2B (Q11): both buyer and seller are verified businesses. */
export const isB2B = (buyerKyc, sellerKyc) => buyerKyc === 'verified' && sellerKyc === 'verified';

export const commissionFor = (amount, { b2b, b2bRate = 0.10, normalRate = 0.025 }) => {
    const rate = b2b ? b2bRate : normalRate;
    return { rate, commission: round2(Number(amount) * rate), sellerNet: round2(Number(amount) * (1 - rate)) };
};

// ─── Ads (#27) ───────────────────────────────────────────────────────────────

export const AD_TYPES = ['contact', 'app', 'website'];

export const adStatusAt = (ad, now = new Date()) => {
    if (['draft', 'awaiting_payment', 'cancelled', 'rejected'].includes(ad.status)) return ad.status;
    if (!ad.startAt || !ad.endAt) return ad.status;
    if (now < new Date(ad.startAt)) return 'scheduled';
    if (now >= new Date(ad.endAt)) return 'completed';
    return 'running';
};

/**
 * Picks ads for one viewer: fair rotation (fewest impressions first, ties
 * broken at random), skipping ads already shown `cap` times today.
 */
export const pickAds = (ads, { count = 1, seenToday = {}, cap = 3, random = Math.random } = {}) => {
    return [...(ads || [])]
        .filter((a) => (seenToday[String(a._id)] || 0) < cap)
        .map((a) => ({ a, k: (a.stats?.impressions || 0) + random() }))
        .sort((x, y) => x.k - y.k)
        .slice(0, Math.max(0, count))
        .map((x) => x.a);
};

export const validateAdCta = (type, cta = {}) => {
    if (type === 'contact') {
        const phone = String(cta.whatsapp || cta.phone || '').replace(/[^\d+]/g, '');
        if (!/^\+?\d{10,13}$/.test(phone)) return 'Add a valid WhatsApp or phone number';
    } else if (type === 'app') {
        if (!/^https:\/\//.test(cta.playStoreUrl || '') && !/^https:\/\//.test(cta.appStoreUrl || '')) return 'Add a Play Store or App Store link';
    } else if (type === 'website') {
        if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(cta.url || '')) return 'Add a website link';
    } else {
        return 'Unknown ad type';
    }
    return null;
};

// ─── One-time listings (#80) ───────────────────────────────────────────────

const BANNED = /\b(gun|pistol|ammo|ganja|cannabis|weed|charas|cocaine|heroin|escort|counterfeit|fake (?:id|aadhaar|pan)|lottery|bitcoin doubler)\b/i;
const CONTACT_IN_TEXT = /(\+?\d[\d\s-]{8,}\d)|(@[a-z0-9.-]+\.[a-z]{2,})/i;

/**
 * Automatic listing checks (Q15). Returns flags; any flag sends the listing
 * to the admin queue instead of straight to payment.
 */
export const listingChecks = (post) => {
    const flags = [];
    const product = post?.customization?.product || post?.customization?.service || {};
    const title = String(product.name || product.title || post?.caption || '');
    const text = `${title} ${post?.description || ''} ${post?.caption || ''}`;
    const price = Number(product.price);
    if (!['product', 'service'].includes(post?.contentType)) flags.push('Not a product or service post');
    if (!title.trim()) flags.push('Missing title');
    if (!Number.isFinite(price) || price <= 0) flags.push('Missing price');
    else if (price > 10000000) flags.push('Price looks wrong');
    if (!(post?.media || []).length) flags.push('No photo or video');
    if (BANNED.test(text)) flags.push('Possibly prohibited item');
    if (CONTACT_IN_TEXT.test(title)) flags.push('Contact details in the title');
    return flags;
};

// ─── Views for verified businesses (#75, Q16) ─────────────────────────────

export const shouldNotifyInstantly = (sentToday, limit = 3) => sentToday < limit;

export const istDay = (d = new Date()) => {
    const ist = new Date(new Date(d).getTime() + 5.5 * 3600 * 1000);
    return ist.toISOString().slice(0, 10);
};

// ─── Plans (#77) ─────────────────────────────────────────────────────────────

export const daysLeft = (until, now = new Date()) => (until ? Math.ceil((new Date(until) - now) / 86400000) : 0);

/** "Expires in 15 days" / "Expires today" / "Valid until 22 Sep 2026". */
export const expiryLabel = (until, now = new Date()) => {
    if (!until) return null;
    const left = daysLeft(until, now);
    if (left < 0) return 'Expired';
    if (left === 0) return 'Expires today';
    if (left <= 30) return `Expires in ${left} day${left === 1 ? '' : 's'}`;
    return `Valid until ${new Date(until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`;
};

export const PLAN_REMINDER_DAYS = [15, 3, 1];

// ─── SEO (#1) ────────────────────────────────────────────────────────────────

export const slugify = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'post';
