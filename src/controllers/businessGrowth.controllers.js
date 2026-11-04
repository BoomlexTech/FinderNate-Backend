import mongoose from 'mongoose';
import Business from '../models/business.models.js';
import BusinessViewDaily from '../models/businessViewDaily.models.js';
import Order from '../models/order.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { tiersFor } from '../utils/businessVisibility.utils.js';
import {
    COMMERCIAL_TYPES, TIERS, daysLeft, effectiveKycStatus, expiryLabel, istDay, round2,
    shouldNotifyInstantly, slugify, PLAN_REMINDER_DAYS,
} from '../utils/phase4.rules.js';

// ─── Views for verified businesses (#75, Q16) ───────────────────────────────

const isVerifiedBusiness = async (userId) => {
    const b = await Business.findOne({ userId }).select('kyc verificationStatus').lean();
    return !!b && effectiveKycStatus(b) === 'verified';
};

/**
 * Counts a profile view or a business-post view for a verified business, and
 * sends an instant notification for the first few each day (Q16); the rest
 * go into the evening digest. Best-effort, never throws.
 */
export const recordBusinessView = async (businessUserId, kind, viewerId = null) => {
    try {
        if (!businessUserId || String(businessUserId) === String(viewerId || '')) return;
        if (!await isVerifiedBusiness(businessUserId)) return;
        const day = istDay();
        const row = await BusinessViewDaily.findOneAndUpdate(
            { businessUserId, day },
            { $inc: { [kind === 'profile' ? 'profileViews' : 'postViews']: 1 } },
            { upsert: true, new: true }
        );
        if (kind !== 'profile') return;
        const limit = Number(await getSettingValue('BUSINESS_VIEW_INSTANT_LIMIT', 3));
        if (!shouldNotifyInstantly(row.instantSent, limit)) return;
        const claimed = await BusinessViewDaily.updateOne({ _id: row._id, instantSent: row.instantSent }, { $inc: { instantSent: 1 } });
        if (!claimed.modifiedCount) return;
        // Named only when the visitor shares their visits (Phase 2 #65).
        const viewer = viewerId ? await User.findById(viewerId).select('username profileVisitsHidden').lean() : null;
        const who = viewer && !viewer.profileVisitsHidden ? `@${viewer.username}` : 'Someone';
        await notifyActivity({
            recipientId: businessUserId,
            senderId: viewer && !viewer.profileVisitsHidden ? viewerId : null,
            type: 'business_views',
            message: `${who} viewed your business profile.`,
        });
    } catch { /* never block a view */ }
};

/** Evening digest: "12 people viewed your profile today". */
export const runBusinessViewDigest = async () => {
    const day = istDay();
    const rows = await BusinessViewDaily.find({ day, digestSentAt: null, $or: [{ profileViews: { $gt: 0 } }, { postViews: { $gt: 0 } }] }).limit(5000).lean();
    for (const r of rows) {
        const extraProfile = Math.max(0, r.profileViews - r.instantSent);
        if (!extraProfile && !r.postViews) continue;
        const parts = [];
        if (r.profileViews) parts.push(`${r.profileViews} ${r.profileViews === 1 ? 'person' : 'people'} viewed your profile`);
        if (r.postViews) parts.push(`your posts got ${r.postViews} view${r.postViews === 1 ? '' : 's'}`);
        await notifyActivity({ recipientId: r.businessUserId, type: 'business_views', message: `Today ${parts.join(' and ')}.`, data: { day } });
        await BusinessViewDaily.updateOne({ _id: r._id }, { $set: { digestSentAt: new Date() } });
    }
};

/** GET /business-growth/views?days=30 — the Insights chart. */
export const getBusinessViews = asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const from = istDay(new Date(Date.now() - (days - 1) * 86400000));
    const rows = await BusinessViewDaily.find({ businessUserId: req.user._id, day: { $gte: from } }).sort({ day: 1 }).lean();
    const totals = rows.reduce((t, r) => ({ profileViews: t.profileViews + r.profileViews, postViews: t.postViews + r.postViews }), { profileViews: 0, postViews: 0 });
    return res.status(200).json(new ApiResponse(200, {
        verified: await isVerifiedBusiness(req.user._id),
        totals,
        daily: rows.map((r) => ({ day: r.day, profileViews: r.profileViews, postViews: r.postViews })),
    }, 'OK'));
});

// ─── B2B statements (#74) ────────────────────────────────────────────────────

const PAID = ['paid', 'held', 'released'];

/** GET /business-growth/statements?from&to&role=seller|buyer[&format=csv] */
export const getStatements = asyncHandler(async (req, res) => {
    const role = req.query.role === 'buyer' ? 'buyer' : 'seller';
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const filter = {
        [role === 'seller' ? 'sellerId' : 'buyerId']: req.user._id,
        createdAt: { $gte: from, $lte: to },
        paymentStatus: { $in: PAID },
    };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(2000)
        .select('orderNumber createdAt amount isB2B commissionRate commissionAmount sellerNetAmount paymentStatus orderStatus productDetails.name buyerId sellerId')
        .lean();
    const lines = orders.map((o) => ({
        orderId: o._id, orderNumber: o.orderNumber, date: o.createdAt, item: o.productDetails?.name,
        amount: o.amount, b2b: !!o.isB2B, commissionRate: o.commissionRate ?? null,
        commission: o.commissionAmount ?? null, sellerNet: o.sellerNetAmount ?? null, status: o.paymentStatus,
    }));
    const sum = (k) => round2(lines.reduce((t, l) => t + (Number(l[k]) || 0), 0));
    const totals = { orders: lines.length, b2bOrders: lines.filter((l) => l.b2b).length, amount: sum('amount'), commission: sum('commission'), sellerNet: sum('sellerNet') };

    if (req.query.format === 'csv') {
        const head = 'Date,Order,Item,Amount,B2B,Commission,Seller net,Status';
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [head, ...lines.map((l) => [new Date(l.date).toISOString().slice(0, 10), l.orderNumber, l.item, l.amount, l.b2b ? 'Yes' : 'No', l.commission, l.sellerNet, l.status].map(esc).join(','))].join('\n');
        res.setHeader('Content-Disposition', `attachment; filename="findernate-statement-${role}.csv"`);
        return res.status(200).type('text/csv').send(csv);
    }
    return res.status(200).json(new ApiResponse(200, { role, from, to, totals, lines }, 'OK'));
});

/** GET /admin/b2b/statements?from&to — platform view of commission earned. */
export const adminB2bStatements = asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const [agg] = await Order.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to }, paymentStatus: { $in: PAID } } },
        { $group: {
            _id: null,
            orders: { $sum: 1 },
            b2bOrders: { $sum: { $cond: ['$isB2B', 1, 0] } },
            gmv: { $sum: '$amount' },
            b2bGmv: { $sum: { $cond: ['$isB2B', '$amount', 0] } },
            commission: { $sum: { $ifNull: ['$commissionAmount', 0] } },
            b2bCommission: { $sum: { $cond: ['$isB2B', { $ifNull: ['$commissionAmount', 0] }, 0] } },
        } },
    ]);
    return res.status(200).json(new ApiResponse(200, { from, to, ...(agg || { orders: 0, b2bOrders: 0, gmv: 0, b2bGmv: 0, commission: 0, b2bCommission: 0 }) }, 'OK'));
});

// ─── Plan for regular users (#77) ───────────────────────────────────────────

/** GET /business-growth/plus — "Findernate Plus": no ads, 30-day pass. */
export const getPlusStatus = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('plusUntil').lean();
    const price = Number(await getSettingValue('PLUS_PLAN_PRICE', null)) || null;
    const includesCalling = (await getSettingValue('PLUS_PLAN_INCLUDES_CALLING', false)) === true;
    const active = !!(user?.plusUntil && new Date(user.plusUntil) > new Date());
    return res.status(200).json(new ApiResponse(200, {
        available: !!price,
        comingSoon: !price,
        price,
        includesCalling,
        benefits: ['No ads', ...(includesCalling ? ['Voice and video calls'] : [])],
        active,
        validUntil: user?.plusUntil || null,
        daysLeft: active ? daysLeft(user.plusUntil) : 0,
        expiryLabel: active ? expiryLabel(user.plusUntil) : null,
    }, 'OK'));
});

/** Daily: plan reminders at 15, 3 and 1 days, and on expiry. */
export const runPlusReminders = async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 16 * 86400000);
    const users = await User.find({ plusUntil: { $ne: null, $lte: soon, $gte: new Date(now.getTime() - 86400000) } }).select('plusUntil plusRemindersSent').limit(5000).lean();
    for (const u of users) {
        const left = daysLeft(u.plusUntil, now);
        const sent = new Set(u.plusRemindersSent || []);
        const due = left <= 0 ? 0 : PLAN_REMINDER_DAYS.filter((d) => left <= d && !sent.has(d)).sort((a, b) => a - b)[0];
        if (due === undefined || (due === 0 && sent.has(0))) continue;
        await notifyActivity({
            recipientId: u._id, type: 'plan_expiry',
            message: due === 0 ? 'Your Findernate Plus has ended. Renew to stay ad-free.' : `Your Findernate Plus expires in ${left} day${left === 1 ? '' : 's'}.`,
        });
        await User.updateOne({ _id: u._id }, { $addToSet: { plusRemindersSent: due } });
    }
};

// ─── SEO feed (#1) ───────────────────────────────────────────────────────────

const PUBLIC_TIERS = new Set([TIERS.PUBLIC, TIERS.PREMIUM]);

/** Indexable = public, not removed, commercial, from a business visible to everyone. */
const indexablePosts = async (filter, limit, skip = 0) => {
    const posts = await Post.find({ contentType: { $in: [...COMMERCIAL_TYPES] }, 'settings.privacy': { $ne: 'private' }, isReported: { $ne: true }, ...filter })
        .sort({ updatedAt: -1 }).skip(skip).limit(limit)
        .select('userId contentType caption description media customization updatedAt createdAt location')
        .lean();
    const { tiers } = await tiersFor(posts.map((p) => p.userId));
    return posts.filter((p) => PUBLIC_TIERS.has(tiers.get(String(p.userId))));
};

const titleOf = (p) => p.customization?.product?.name || p.customization?.service?.name || p.customization?.business?.businessName || String(p.caption || '').slice(0, 70) || 'Listing';

/** GET /seo/sitemap?type=posts|businesses&page — public. */
export const seoSitemap = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = 2000;
    if (req.query.type === 'businesses') {
        const rows = await Business.find({ visibilityTier: { $in: [...PUBLIC_TIERS] } }).sort({ updatedAt: -1 }).skip((page - 1) * size).limit(size).select('userId businessName updatedAt').lean();
        const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('username').lean();
        const byId = new Map(users.map((u) => [String(u._id), u.username]));
        return res.status(200).json(new ApiResponse(200, {
            items: rows.filter((r) => byId.get(String(r.userId))).map((r) => ({ username: byId.get(String(r.userId)), name: r.businessName, updatedAt: r.updatedAt })),
            hasMore: rows.length === size,
        }, 'OK'));
    }
    const posts = await indexablePosts({}, size, (page - 1) * size);
    return res.status(200).json(new ApiResponse(200, {
        items: posts.map((p) => ({ id: p._id, slug: slugify(titleOf(p)), type: p.contentType, updatedAt: p.updatedAt })),
        hasMore: posts.length === size,
    }, 'OK'));
});

/** GET /seo/post/:id — public data for a server-rendered listing page. */
export const seoPost = asyncHandler(async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new ApiError(404, 'Not found');
    const [post] = await indexablePosts({ _id: new mongoose.Types.ObjectId(req.params.id) }, 1);
    if (!post) {
        const exists = await Post.exists({ _id: req.params.id });
        return res.status(exists ? 200 : 404).json(new ApiResponse(exists ? 200 : 404, { indexable: false }, exists ? 'Not indexable' : 'Not found'));
    }
    const [user, business] = await Promise.all([
        User.findById(post.userId).select('username fullName profileImageUrl').lean(),
        Business.findOne({ userId: post.userId }).select('businessName location contact.phone rating category').lean(),
    ]);
    const product = post.customization?.product || post.customization?.service || {};
    return res.status(200).json(new ApiResponse(200, {
        indexable: true,
        id: post._id,
        slug: slugify(titleOf(post)),
        type: post.contentType,
        title: titleOf(post),
        description: String(post.description || post.caption || '').slice(0, 500),
        images: (post.media || []).map((m) => m.thumbnailUrl || m.url).filter(Boolean).slice(0, 6),
        price: Number(product.price) || null,
        currency: product.currency || 'INR',
        inStock: product.inStock !== false,
        updatedAt: post.updatedAt,
        seller: { username: user?.username, name: business?.businessName || user?.fullName, image: user?.profileImageUrl },
        business: business ? {
            name: business.businessName,
            category: business.category,
            address: business.location ? { street: business.location.address, city: business.location.city, state: business.location.state, postalCode: business.location.postalCode, country: business.location.country || 'IN' } : null,
            rating: business.rating || null,
        } : null,
    }, 'OK'));
});

/** GET /seo/business/:username — public data for a business profile page. */
export const seoBusiness = asyncHandler(async (req, res) => {
    const user = await User.findOne({ username: String(req.params.username).toLowerCase() }).select('_id username fullName profileImageUrl bio').lean();
    const business = user ? await Business.findOne({ userId: user._id }).lean() : null;
    if (!business || !PUBLIC_TIERS.has(business.visibilityTier)) return res.status(200).json(new ApiResponse(200, { indexable: false }, 'Not indexable'));
    const posts = await indexablePosts({ userId: user._id }, 24);
    return res.status(200).json(new ApiResponse(200, {
        indexable: true,
        username: user.username,
        name: business.businessName,
        description: business.description || user.bio || '',
        category: business.category,
        logo: business.logoUrl || user.profileImageUrl,
        phone: business.contact?.phone || null,
        website: business.website || business.contact?.website || null,
        address: business.location ? { street: business.location.address, city: business.location.city, state: business.location.state, postalCode: business.location.postalCode, country: business.location.country || 'IN' } : null,
        rating: business.rating || null,
        posts: posts.map((p) => ({ id: p._id, slug: slugify(titleOf(p)), title: titleOf(p), image: p.media?.[0]?.thumbnailUrl || p.media?.[0]?.url, price: Number((p.customization?.product || p.customization?.service || {}).price) || null })),
    }, 'OK'));
});

/** Hourly: stored tiers (for SEO and the admin panel) and the Q10 recheck deadline. */
export const runKycMaintenance = async () => {
    const { verificationConfigured } = await import('../services/cashfreeVerify.service.js');
    const grace = Number(await getSettingValue('KYC_RECHECK_GRACE_DAYS', 30));
    // Q10: start the 30-day clock for businesses approved before Phase 4,
    // but only once the automatic check exists to complete.
    if (verificationConfigured()) {
        const legacy = await Business.find({ verificationStatus: 'approved', 'kyc.status': { $exists: false } }).select('_id userId').limit(1000).lean();
        for (const b of legacy) {
            const due = new Date(Date.now() + grace * 86400000);
            await Business.updateOne({ _id: b._id }, { $set: { 'kyc.status': 'verified', 'kyc.source': 'legacy_admin', 'kyc.recheckDueAt': due } });
            await notifyActivity({ recipientId: b.userId, type: 'kyc', message: `Please complete the automatic business check by ${due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, or your business posts will be hidden.` });
        }
    }
    const businesses = await Business.find({}).select('userId visibilityTier').lean();
    const { tiers } = await tiersFor(businesses.map((b) => b.userId));
    for (const b of businesses) {
        const t = tiers.get(String(b.userId));
        if (t && t !== b.visibilityTier) {
            await Business.updateOne({ _id: b._id }, { $set: { visibilityTier: t } });
            if (b.visibilityTier && t === TIERS.NETWORK && PUBLIC_TIERS.has(b.visibilityTier)) {
                await notifyActivity({ recipientId: b.userId, type: 'kyc', message: 'Your plan has ended. Your business posts are now shown only to your followers.' });
            }
        }
    }
};
