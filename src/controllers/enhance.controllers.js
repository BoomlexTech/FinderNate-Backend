import multer from 'multer';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import EnhanceUsage from '../models/enhanceUsage.models.js';
import { resolvePlanTier } from '../utils/planLimits.js';
import { getSettingValue } from '../utils/appSettings.utils.js';
import { ENHANCE_MODES, enhanceLimitFor, istMonthKey, nextIstMonthStart } from '../utils/phase5.rules.js';
import { enhanceLocally, placeOnBackground, prepareForCutout } from '../utils/photoEnhance.utils.js';
import { photoroomConfigured, removeBackground } from '../services/photoroom.service.js';

/**
 * Photo enhancer (Phase 5 #35).
 *
 *   GET  /enhance/config   what is on, and this month's use
 *   POST /enhance          image + mode (auto | remove_background)
 *
 * The picture goes through this server and comes straight back in the reply;
 * nothing is stored. Each use counts against a monthly cap that depends on the
 * plan (admin settings ENHANCE_LIMIT_FREE / _SMALL_BUSINESS / _CORPORATE).
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const enhanceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp|avif)$/.test(file.mimetype || '')) return cb(null, true);
        return cb(Object.assign(new Error('Choose a JPEG, PNG or WebP photo.'), { status: 400 }), false);
    },
}).single('image');

export const receiveEnhanceImage = (req, res, next) => enhanceUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, 'Photos can be up to 10 MB.'));
    return next(new ApiError(err.status || 400, err.message || 'Could not read the photo.'));
});

const limitsFromSettings = async () => ({
    free: await getSettingValue('ENHANCE_LIMIT_FREE', undefined),
    small_business: await getSettingValue('ENHANCE_LIMIT_SMALL_BUSINESS', undefined),
    corporate: await getSettingValue('ENHANCE_LIMIT_CORPORATE', undefined),
});

const usageFor = async (userId) => {
    const [tier, overrides] = await Promise.all([resolvePlanTier(userId), limitsFromSettings()]);
    const limit = enhanceLimitFor(tier, overrides);
    const month = istMonthKey();
    const row = await EnhanceUsage.findOne({ userId, month }).select('count').lean();
    const used = row?.count || 0;
    return { tier, limit, used, remaining: Math.max(0, limit - used), resetsAt: nextIstMonthStart(), month };
};

const enhancerOn = async () => {
    const v = await getSettingValue('ENHANCE_ENABLED', true);
    return v !== false && v !== 'false';
};

/** GET /enhance/config */
export const getEnhanceConfig = asyncHandler(async (req, res) => {
    const [on, usage] = await Promise.all([enhancerOn(), usageFor(req.user._id)]);
    return res.status(200).json(new ApiResponse(200, {
        available: on,
        modes: { auto: on, removeBackground: on && photoroomConfigured() },
        usage: { used: usage.used, limit: usage.limit, remaining: usage.remaining, resetsAt: usage.resetsAt, tier: usage.tier },
    }, 'Photo enhancer'));
});

/** Takes one use, or says the month's allowance is gone. */
const consumeUse = async (userId, limit, month) => {
    if (limit <= 0) return false;
    try {
        await EnhanceUsage.findOneAndUpdate(
            { userId, month, count: { $lt: limit } },
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );
        return true;
    } catch (e) {
        if (e?.code === 11000) return false; // the row exists and is already at the limit
        throw e;
    }
};

const refundUse = (userId, month) =>
    EnhanceUsage.updateOne({ userId, month, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => {});

/** POST /enhance (multipart: image; fields mode, background) */
export const enhancePhoto = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    if (!req.file?.buffer) throw new ApiError(400, 'Choose a photo to enhance.');
    if (!(await enhancerOn())) throw new ApiError(503, 'The photo enhancer is not available right now.');
    const mode = req.body?.mode || 'auto';
    if (!ENHANCE_MODES.includes(mode)) throw new ApiError(400, 'Choose "auto" or "remove_background".');
    if (mode === 'remove_background' && !photoroomConfigured()) {
        throw new ApiError(503, 'Background removal is not available yet.');
    }

    const { tier, limit, month } = await usageFor(userId);
    if (!(await consumeUse(userId, limit, month))) {
        throw new ApiError(429, limit <= 0
            ? 'The photo enhancer is not included in your plan.'
            : `You've used all ${limit} enhancements for this month. They come back on the 1st.`);
    }

    let result;
    try {
        if (mode === 'remove_background') {
            const cutout = await removeBackground(await prepareForCutout(req.file.buffer));
            result = await placeOnBackground(cutout, req.body?.background || '#ffffff');
        } else {
            result = await enhanceLocally(req.file.buffer);
        }
    } catch (err) {
        await refundUse(userId, month); // a failed attempt does not cost a use
        if (err instanceof ApiError) throw err;
        throw new ApiError(422, "We couldn't enhance that photo. Try a different one.");
    }

    const usage = await usageFor(userId);
    const mime = result.format === 'png' ? 'image/png' : 'image/jpeg';
    return res.status(200).json(new ApiResponse(200, {
        image: `data:${mime};base64,${result.buffer.toString('base64')}`,
        width: result.width,
        height: result.height,
        mode,
        usage: { used: usage.used, limit: usage.limit, remaining: usage.remaining, resetsAt: usage.resetsAt, tier },
    }, 'Photo enhanced'));
});
