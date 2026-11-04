import mongoose from 'mongoose';
import AdCampaign from '../models/adCampaign.models.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import Subscription from '../models/subscription.models.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { redisClient } from '../config/redis.config.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { AD_TYPES, adPrice, adStatusAt, istDay, pickAds, validateAdCta } from '../utils/phase4.rules.js';
import { gstPercent, playProducts } from './platformPayments.controllers.js';

/**
 * Paid ads (Phase 4 #27). ₹100/day by default (AD_DAILY_FEE), plus GST,
 * shown to all users (Q14), never to subscribers (#77).
 */

const adSettings = async () => ({
    enabled: (await getSettingValue('ADS_ENABLED', true)) !== false,
    dailyFee: Number(await getSettingValue('AD_DAILY_FEE', 100)),
    minDays: Number(await getSettingValue('AD_MIN_DAYS', 1)),
    maxDays: Number(await getSettingValue('AD_MAX_DAYS', 30)),
    feedInterval: Number(await getSettingValue('AD_FEED_INTERVAL', 6)),
    frequencyCap: Number(await getSettingValue('AD_FREQUENCY_CAP', 3)),
    needsApproval: (await getSettingValue('AD_REQUIRES_APPROVAL', false)) === true,
});

/** GET /ads/config */
export const getAdConfig = asyncHandler(async (req, res) => {
    const s = await adSettings();
    return res.status(200).json(new ApiResponse(200, {
        ...s,
        gstPercent: await gstPercent(),
        types: AD_TYPES,
        playProducts: (await playProducts()).ad,
    }, 'OK'));
});

const cleanCreative = (c = {}) => ({
    headline: String(c.headline || '').slice(0, 80),
    body: String(c.body || '').slice(0, 300),
    mediaUrl: /^https:\/\//.test(c.mediaUrl || '') ? c.mediaUrl : undefined,
    mediaType: c.mediaType === 'video' ? 'video' : 'image',
});

const cleanCta = (c = {}) => ({
    label: String(c.label || '').slice(0, 24) || undefined,
    whatsapp: c.whatsapp ? String(c.whatsapp).replace(/[^\d+]/g, '') : undefined,
    phone: c.phone ? String(c.phone).replace(/[^\d+]/g, '') : undefined,
    url: c.url ? String(c.url).trim() : undefined,
    playStoreUrl: c.playStoreUrl ? String(c.playStoreUrl).trim() : undefined,
    appStoreUrl: c.appStoreUrl ? String(c.appStoreUrl).trim() : undefined,
});

/** POST /ads  { type, postId?, creative?, cta, days, startAt? } → draft with price. */
export const createAd = asyncHandler(async (req, res) => {
    const s = await adSettings();
    if (!s.enabled || !s.dailyFee) throw new ApiError(409, 'Ads are not available right now');
    const { type, postId } = req.body || {};
    if (!AD_TYPES.includes(type)) throw new ApiError(400, 'Choose WhatsApp/contact, app or website');
    const days = parseInt(req.body?.days, 10);
    if (!Number.isInteger(days) || days < s.minDays || days > s.maxDays) throw new ApiError(400, `Choose between ${s.minDays} and ${s.maxDays} days`);
    const cta = cleanCta(req.body?.cta);
    const ctaError = validateAdCta(type, cta);
    if (ctaError) throw new ApiError(400, ctaError);

    let creative = cleanCreative(req.body?.creative);
    if (postId) {
        if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(400, 'Invalid post');
        const post = await Post.findOne({ _id: postId, userId: req.user._id }).select('_id').lean();
        if (!post) throw new ApiError(404, 'You can only promote your own posts');
    } else if (!creative.mediaUrl || !creative.headline) {
        throw new ApiError(400, 'Add a picture or video and a headline, or choose one of your posts');
    }

    const gstP = await gstPercent();
    const price = adPrice(days, s.dailyFee, gstP);
    const startAt = req.body?.startAt ? new Date(req.body.startAt) : null;
    const ad = await AdCampaign.create({
        userId: req.user._id, type, postId: postId || null, creative, cta, days,
        dailyFee: s.dailyFee, gstPercent: gstP, amount: price.amount, gst: price.gst, total: price.total,
        requestedStartAt: startAt && startAt > new Date() ? startAt : null,
        status: 'draft',
    });
    return res.status(201).json(new ApiResponse(201, ad, 'Ad created. Pay to schedule it.'));
});

const shape = (ad) => {
    const o = ad.toObject ? ad.toObject() : ad;
    const daily = o.stats?.daily instanceof Map ? Object.fromEntries(o.stats.daily) : (o.stats?.daily || {});
    return {
        ...o,
        status: adStatusAt(o),
        stats: {
            impressions: o.stats?.impressions || 0,
            clicks: o.stats?.clicks || 0,
            ctr: o.stats?.impressions ? Math.round((o.stats.clicks / o.stats.impressions) * 1000) / 10 : 0,
            daily,
        },
    };
};

/** GET /ads/mine */
export const myAds = asyncHandler(async (req, res) => {
    const ads = await AdCampaign.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).populate('postId', 'caption media contentType');
    return res.status(200).json(new ApiResponse(200, { ads: ads.map(shape) }, 'OK'));
});

/** GET /ads/:id */
export const getAd = asyncHandler(async (req, res) => {
    const ad = await AdCampaign.findOne({ _id: req.params.id, userId: req.user._id }).populate('postId', 'caption media contentType');
    if (!ad) throw new ApiError(404, 'Ad not found');
    return res.status(200).json(new ApiResponse(200, shape(ad), 'OK'));
});

/** DELETE /ads/:id — cancel a draft (paid ads are cancelled by support, with a refund). */
export const cancelAd = asyncHandler(async (req, res) => {
    const ad = await AdCampaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!ad) throw new ApiError(404, 'Ad not found');
    if (!['draft', 'awaiting_payment'].includes(ad.status)) throw new ApiError(409, 'A paid ad can only be cancelled by support. Contact us for a refund.');
    ad.status = 'cancelled';
    await ad.save();
    return res.status(200).json(new ApiResponse(200, { cancelled: true }, 'Ad cancelled'));
});

// ─── Serving ─────────────────────────────────────────────────────────────────

/** Subscribers see no ads (#77): Findernate Plus or any paid business plan. */
export const isAdFree = async (userId) => {
    if (!userId) return false;
    const [user, sub] = await Promise.all([
        User.findById(userId).select('plusUntil').lean(),
        Subscription.findOne({ userId, status: 'active', plan: { $ne: 'free' }, endDate: { $gt: new Date() } }).select('_id').lean(),
    ]);
    return !!sub || !!(user?.plusUntil && new Date(user.plusUntil) > new Date());
};

const seenKey = (userId) => `ads:seen:${userId}:${istDay()}`;

/** GET /ads/serve?count=2&placement=feed|vibes */
export const serveAds = asyncHandler(async (req, res) => {
    const s = await adSettings();
    const userId = req.user?._id;
    if (!s.enabled || await isAdFree(userId)) {
        return res.status(200).json(new ApiResponse(200, { ads: [], interval: s.feedInterval, adFree: true }, 'OK'));
    }
    const now = new Date();
    const running = await AdCampaign.find({ status: { $in: ['running', 'scheduled'] }, startAt: { $lte: now }, endAt: { $gt: now }, ...(userId ? { userId: { $ne: userId } } : {}) })
        .populate('postId', 'caption media contentType customization userId')
        .populate('userId', 'username fullName profileImageUrl')
        .lean();
    let seen = {};
    if (userId) {
        try { seen = Object.fromEntries(Object.entries(await redisClient.hgetall(seenKey(userId)) || {}).map(([k, v]) => [k, Number(v)])); } catch { /* best effort */ }
    }
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 1, 1), 5);
    const chosen = pickAds(running, { count, seenToday: seen, cap: s.frequencyCap });
    return res.status(200).json(new ApiResponse(200, {
        interval: s.feedInterval,
        adFree: false,
        ads: chosen.map((a) => ({
            _id: a._id,
            type: a.type,
            sponsored: true,
            advertiser: a.userId ? { _id: a.userId._id, username: a.userId.username, fullName: a.userId.fullName, profileImageUrl: a.userId.profileImageUrl } : null,
            creative: a.postId ? {
                headline: a.creative?.headline || a.postId.customization?.product?.name || '',
                body: a.creative?.body || a.postId.caption || '',
                mediaUrl: a.postId.media?.[0]?.thumbnailUrl || a.postId.media?.[0]?.url,
                mediaType: a.postId.media?.[0]?.type === 'video' ? 'video' : 'image',
                postId: a.postId._id,
            } : a.creative,
            cta: a.cta,
        })),
    }, 'OK'));
});

const bump = async (req, field) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid ad');
    const day = istDay();
    const userId = req.user?._id;
    if (field === 'impressions' && userId) {
        try {
            const key = seenKey(userId);
            const n = await redisClient.hincrby(key, id, 1);
            await redisClient.expire(key, 2 * 86400);
            if (n > 20) return; // ignore runaway repeats from one viewer
        } catch { /* best effort */ }
    }
    if (field === 'clicks' && userId) {
        try {
            const ok = await redisClient.set(`ads:click:${id}:${userId}:${day}`, '1', 'EX', 86400, 'NX');
            if (!ok) return; // one counted click per viewer per day
        } catch { /* best effort */ }
    }
    await AdCampaign.updateOne({ _id: id, status: { $in: ['running', 'scheduled'] } }, { $inc: { [`stats.${field}`]: 1, [`stats.daily.${day}.${field}`]: 1 } });
};

/** POST /ads/:id/impression */
export const adImpression = asyncHandler(async (req, res) => {
    await bump(req, 'impressions');
    return res.status(204).end();
});

/** POST /ads/:id/click */
export const adClick = asyncHandler(async (req, res) => {
    await bump(req, 'clicks');
    return res.status(204).end();
});

// ─── Lifecycle job and admin ─────────────────────────────────────────────────

export const runAdLifecycle = async () => {
    const now = new Date();
    await AdCampaign.updateMany({ status: 'scheduled', startAt: { $lte: now }, endAt: { $gt: now } }, { $set: { status: 'running' } });
    const ending = await AdCampaign.find({ status: { $in: ['running', 'scheduled'] }, endAt: { $lte: now } }).select('_id userId stats').limit(500).lean();
    for (const ad of ending) {
        await AdCampaign.updateOne({ _id: ad._id }, { $set: { status: 'completed' } });
        await notifyActivity({
            recipientId: ad.userId, type: 'ad',
            message: `Your ad has ended: ${ad.stats?.impressions || 0} views and ${ad.stats?.clicks || 0} taps.`,
            data: { adId: String(ad._id) },
        });
    }
};

/** GET /admin/ads?status= */
export const adminListAds = asyncHandler(async (req, res) => {
    const filter = req.query.status ? { status: String(req.query.status) } : {};
    const ads = await AdCampaign.find(filter).sort({ createdAt: -1 }).limit(200).populate('userId', 'username fullName').lean();
    return res.status(200).json(new ApiResponse(200, { ads: ads.map(shape) }, 'OK'));
});

/** POST /admin/ads/:id/reject  { reason } — stops an ad (refund handled by support). */
export const adminRejectAd = asyncHandler(async (req, res) => {
    const ad = await AdCampaign.findById(req.params.id);
    if (!ad) throw new ApiError(404, 'Ad not found');
    ad.status = 'rejected';
    ad.rejectionReason = String(req.body?.reason || 'Does not follow the ad policy').slice(0, 300);
    await ad.save();
    await notifyActivity({ recipientId: ad.userId, type: 'ad', message: `Your ad was stopped: ${ad.rejectionReason}. Support will contact you about a refund.`, data: { adId: String(ad._id) } });
    return res.status(200).json(new ApiResponse(200, { status: ad.status }, 'Ad stopped'));
});
