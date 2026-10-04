import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';
import { PLATFORM_STORE_USER_ID } from '../constants/platformStore.js';

// Fixed store owner — hardcoded in DB query, never exposed via client params
const STORE_USER_ID = new mongoose.Types.ObjectId(PLATFORM_STORE_USER_ID);

// Is `post` genuinely part of the online store's catalogue?
//
// Same three conditions the listing query below filters on — owner, product
// content type, and not private — read from the same constant, so the
// catalogue and the checkout can never disagree about what the store sells.
//
// The store CHECKOUT (cashfree.payment.controller.js → createOnlineStoreOrder)
// is what needs this. That endpoint is public and unauthenticated, and it mints
// a PaymentLink stamped pricingFlow:'online_store' — the marker that unlocks
// the store's shipping-waived total on the shareable /post/:postId/pay/:amount
// URL. Without this check one free anonymous request handed that pricing to any
// post on the platform, permanently.
export const isOnlineStoreListing = (post) =>
    !!post &&
    STORE_USER_ID.equals(post.userId) &&
    post.contentType === 'product' &&
    post.settings?.privacy !== 'private';

/**
 * GET /api/v1/posts/online-store/products
 * Public endpoint — no auth required.
 * Always fetches contentType=product for the fixed store owner.
 *
 * Query params:
 *   page        {number}  default 1
 *   limit       {number}  default 12, max 50
 *   search      {string}  searches product name, description, category
 *   category    {string}  exact category filter
 *   minPrice    {number}
 *   maxPrice    {number}
 *   sortBy      {string}  popular | rating | price-low | price-high
 */
export const getOnlineStoreProducts = asyncHandler(async (req, res) => {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
    const skip     = (page - 1) * limit;
    const search   = req.query.search?.trim();
    const category = req.query.category?.trim();
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    const sortBy   = req.query.sortBy || 'popular';

    // ── Base filter ──────────────────────────────────────────────────────────
    const filter = {
        userId:             STORE_USER_ID,
        contentType:        'product',
        'settings.privacy': { $ne: 'private' }  // Never show private product posts
    };

    // ── Search (name, description, category) ────────────────────────────────
    if (search) {
        const regex = new RegExp(search, 'i');
        filter.$or = [
            { 'customization.product.name':        regex },
            { 'customization.product.description': regex },
            { 'customization.product.category':    regex },
            { caption:                             regex },
        ];
    }

    // ── Category filter ──────────────────────────────────────────────────────
    if (category) {
        filter['customization.product.category'] = new RegExp(`^${category}$`, 'i');
    }

    // ── Price range filter ───────────────────────────────────────────────────
    if (minPrice !== null || maxPrice !== null) {
        filter['customization.product.price'] = {};
        if (minPrice !== null) filter['customization.product.price'].$gte = minPrice;
        if (maxPrice !== null) filter['customization.product.price'].$lte = maxPrice;
    }

    // ── Sort ─────────────────────────────────────────────────────────────────
    let sort = {};
    switch (sortBy) {
        case 'rating':      sort = { 'engagement.likes': -1 };                      break;
        case 'price-low':   sort = { 'customization.product.price':  1 };           break;
        case 'price-high':  sort = { 'customization.product.price': -1 };           break;
        case 'popular':
        default:            sort = { 'engagement.views': -1, createdAt: -1 };       break;
    }

    // ── Execute queries in parallel ──────────────────────────────────────────
    const [posts, totalCount, allCategories] = await Promise.all([
        Post.find(filter).sort(sort).skip(skip).limit(limit).lean(),
        Post.countDocuments(filter),
        // Fetch all distinct categories for the store (unfiltered, for the filter UI)
        Post.distinct('customization.product.category', {
            userId:      STORE_USER_ID,
            contentType: 'product',
            status:      'published',
        }),
    ]);

    // ── Shape response ───────────────────────────────────────────────────────
    // The order endpoint (createOnlineStoreOrder) is what actually charges the
    // buyer, so this listing must quote exactly what that endpoint computes:
    // same GST default (0 when the seller left it blank — NOT 5), same free
    // shipping threshold, same rounding. The store page used to invent a 5% tax
    // line the server never collected.
    const products = posts.map((post) => {
        const p = post.customization?.product || {};
        const image =
            (p.images && p.images[0]) ||
            post.media?.[0]?.url ||
            '';

        const price           = Number(p.price)           || 0;
        const shippingCharges = Number(p.shippingCharges) || 0;
        const gstPercent      = Number(p.gstPercent)      || 0;
        const gstAmount         = parseFloat(((price * gstPercent) / 100).toFixed(2));
        const effectiveShipping = price >= 499 ? 0 : shippingCharges; // free shipping on orders ≥ ₹499
        const totalPrice        = parseFloat((price + effectiveShipping + gstAmount).toFixed(2));

        return {
            _id:             post._id,
            name:            p.name            || post.caption || 'Product',
            category:        p.category        || '',
            price,
            // The seller enters both of these and the store dropped them, so
            // every listing rendered in a default currency with no way through
            // to the product.
            currency:        p.currency        || 'INR',
            link:            p.link            || '',
            originalPrice:   price,                     // extend if you add MRP field
            description:     p.description     || post.description || '',
            rating:          0,                         // extend when reviews are wired up
            image,
            inStock:         p.inStock         ?? true,
            discount:        0,                         // extend if discount field is added
            gstPercent,
            shippingCharges,
            // Server-authoritative figures — the client should display these
            // rather than recomputing tax/shipping with its own defaults.
            gstAmount,
            effectiveShipping,
            totalPrice,
        };
    });

    const categories = allCategories.filter(Boolean).sort();

    return res.status(200).json(
        new ApiResponse(200, {
            products,
            totalCount,
            totalPages:  Math.ceil(totalCount / limit),
            currentPage: page,
            categories,
        }, 'Store products fetched successfully')
    );
});
