import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import BinItem from '../models/binItem.models.js';
import { restoreFromBin, purgeBinItem } from '../utils/bin.utils.js';
import { invalidatePostCaches } from './post/helpers.js';

const toListItem = (item) => ({
    _id: item._id,
    kind: item.kind,
    originalId: item.originalId,
    preview: item.preview,
    deletedAt: item.deletedAt,
    purgeAfter: item.purgeAfter,
    daysLeft: Math.max(0, Math.ceil((new Date(item.purgeAfter) - Date.now()) / (24 * 60 * 60 * 1000))),
});

const ownItem = async (binId, userId) => {
    if (!mongoose.Types.ObjectId.isValid(String(binId))) throw new ApiError(404, 'Not in your Bin');
    const item = await BinItem.findOne({ _id: binId, userId });
    if (!item) throw new ApiError(404, 'Not in your Bin');
    return item;
};

/** GET /bin?page&limit */
export const listBin = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const [items, total] = await Promise.all([
        BinItem.find({ userId }).sort({ deletedAt: -1 }).skip((page - 1) * limit).limit(limit)
            .select('kind originalId preview deletedAt purgeAfter').lean(),
        BinItem.countDocuments({ userId }),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        items: items.map(toListItem),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Bin fetched'));
});

/** POST /bin/:binId/restore */
export const restoreBinItem = asyncHandler(async (req, res) => {
    const item = await ownItem(req.params.binId, req.user._id);
    let doc;
    try {
        doc = await restoreFromBin(item);
    } catch (err) {
        if (err?.code === 11000) throw new ApiError(409, 'This item has already been restored');
        throw err;
    }
    await invalidatePostCaches(doc._id, req.user._id);
    return res.status(200).json(new ApiResponse(200, { kind: item.kind, id: doc._id }, 'Restored'));
});

/** DELETE /bin/:binId — delete now. */
export const deleteBinItemNow = asyncHandler(async (req, res) => {
    const item = await ownItem(req.params.binId, req.user._id);
    await purgeBinItem(item);
    return res.status(200).json(new ApiResponse(200, { binId: item._id }, 'Deleted permanently'));
});

/** DELETE /bin — empty the Bin. */
export const emptyBin = asyncHandler(async (req, res) => {
    const items = await BinItem.find({ userId: req.user._id }).limit(500);
    let deleted = 0;
    for (const item of items) {
        try { await purgeBinItem(item); deleted += 1; } catch (err) {
            console.warn(`[bin] purge failed for ${item._id}: ${err?.message}`);
        }
    }
    return res.status(200).json(new ApiResponse(200, { deleted }, 'Bin emptied'));
});
