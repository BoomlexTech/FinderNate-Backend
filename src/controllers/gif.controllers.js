import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { giphyConfigured, listGifs } from '../services/giphy.service.js';

const ensureConfigured = () => {
    if (!giphyConfigured()) throw new ApiError(503, "GIFs aren't available right now");
};

const respond = async (req, res, q) => {
    ensureConfigured();
    try {
        const result = await listGifs({
            q,
            type: req.query.type === 'stickers' ? 'stickers' : 'gifs',
            limit: req.query.limit,
            offset: req.query.offset,
        });
        return res.status(200).json(new ApiResponse(200, { ...result, attribution: 'Powered by GIPHY' }, 'OK'));
    } catch (error) {
        console.error('[giphy]', error?.message || error);
        throw new ApiError(502, "Couldn't load GIFs. Try again.");
    }
};

/** GET /gifs/search?q=&type=gifs|stickers&limit=&offset= (Phase 3 #7) */
export const searchGifs = asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new ApiError(400, 'q is required');
    return respond(req, res, q);
});

/** GET /gifs/trending?type=gifs|stickers&limit=&offset= */
export const trendingGifs = asyncHandler(async (req, res) => respond(req, res, ''));
