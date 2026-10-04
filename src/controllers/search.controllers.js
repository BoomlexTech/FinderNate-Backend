import mongoose from 'mongoose';
import { User } from '../models/user.models.js';
import Business from '../models/business.models.js';
import Post from '../models/userPost.models.js';
import SearchSuggestion from '../models/searchSuggestion.models.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTypesenseEnabled } from '../config/typesense.config.js';
import { getBlockedUsersFilter } from '../middlewares/blocking.middleware.js';
import { filterBusinessPostsByPaymentPlan, bulkCheckActivePaymentPlans } from '../utils/businessPlan.utils.js';
import {
    instantSearch as tsInstantSearch,
    searchProfiles as tsSearchProfiles,
    searchContent as tsSearchContent,
} from '../services/typesense/index.js';

/* --------------------------------- helpers -------------------------------- */

/**
 * Blocked-user ids for this request, whichever way the route was wired.
 *
 * /search/instant and /search/profiles run getBlockedUsers, so req.blockedUsers
 * is already there. /search/products does NOT — and the controller ignored
 * blocking entirely, so a blocked seller's products stayed in the results even
 * though the same person's profile was correctly filtered out of the profile
 * search two lines away. Reuses the existing cached helper rather than adding a
 * second definition of "blocked".
 */
const resolveBlockedUsers = async (req) => {
    if (Array.isArray(req.blockedUsers)) return req.blockedUsers;
    const userId = req.user?._id;
    if (!userId) return [];
    const filter = await getBlockedUsersFilter(userId);
    return filter?._id?.$nin || [];
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};
const toFloat = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
};

// Only surface public, published content in search (mirrors the Typesense `isPublic`
// mapping: privacy !== 'private' && status not in [draft, archived]).
const PUBLIC_POST_FILTER = {
    'settings.privacy': { $ne: 'private' },
    status: { $nin: ['draft', 'archived'] },
};

/**
 * Canonical product-card shape. BOTH the Typesense path (via the service) and these
 * Mongo fallbacks must return the exact same keys so the frontend renders identically
 * whether or not Typesense is up. Seller fields are filled when the caller joined the
 * author into `_author` (searchProducts does); the cheap typeahead fallback does not,
 * and leaves them null.
 */
const postToProductCard = (p) => {
    const prod = p.customization?.product || {};
    const author = Array.isArray(p._author) ? p._author[0] : p._author;
    return {
        _id: p._id,
        name: prod.name || null,
        image: (Array.isArray(prod.images) && prod.images[0]) || p.media?.[0]?.thumbnailUrl || p.media?.[0]?.url || null,
        price: Number.isFinite(prod.price) ? prod.price : null,
        currency: prod.currency || null,
        category: prod.category || null,
        subcategory: prod.subcategory || null,
        brand: prod.brand || null,
        tags: Array.isArray(prod.tags) ? prod.tags : [],
        locationCity: prod.location?.city || null,
        username: author?.username || null,
        userProfileImageUrl: author?.profileImageUrl || null,
        contentType: p.contentType || null,
    };
};

/**
 * Typesense answered, but with nothing.
 *
 * The read helpers return null only when the integration is switched off; a
 * live-but-EMPTY collection answers `found: 0` and the controllers used to hand
 * that straight back as "no results". Nothing keeps the index populated on its
 * own — `ensureCollections()` creates the collections empty at boot and the
 * backfill/sync scripts are run by hand — so an un-backfilled or half-synced
 * deployment reported "no products" for every query while the same products sat
 * in MongoDB, reachable by the fallback two lines below. Treating an empty
 * engine result as "ask MongoDB too" costs one extra query on genuinely empty
 * searches and removes that whole class of silent blank screen.
 */
const isEmptyTsResult = (r) => !r || !r.found;

/**
 * Accounts a stale index must not be allowed to surface. `$nin`/`$ne` both match
 * a MISSING field, so legacy rows without accountStatus/isDeleted are kept.
 */
const VISIBLE_USER_FILTER = {
    accountStatus: { $nin: ['deactivated', 'banned'] },
    isDeleted: { $ne: true },
};

/**
 * Drops search hits the index should no longer be serving.
 *
 * Typesense is a SEPARATE store kept in step by a dedicated worker process
 * (`npm run typesense:sync`, src/scripts/typesense.sync.js). If that worker is
 * not running, the index freezes at whatever the last backfill wrote and keeps
 * answering with it — posts that have since been deleted, and sellers whose
 * accounts are gone, still come back as perfectly ordinary results. Tapping one
 * opens a 404, and to the person searching it reads as "search returns junk".
 *
 * [visibilityFilter] is why this is not merely an existence check. A frozen
 * index also holds the PUBLISHING STATE the document had when it was last
 * indexed: a listing the seller has since made private or archived still
 * carries isPublic:true there, passes Typesense's own filter_by, and — being
 * very much still present in MongoDB — would sail through an existence-only
 * check and be disclosed with its image and price. No controller calls
 * indexPost/removePost, so nothing else corrects that state. Re-asserting the
 * SAME predicate the Mongo fallback applies keeps the two paths in this file
 * from disagreeing about who may see what.
 *
 * The guard only ever removes hits it has positively disproved: a doc with no
 * id, or an id that is not an ObjectId, is kept.
 *
 * Costs one indexed query per search over at most `perPage` ids. Applied only
 * to the Typesense path — the Mongo fallbacks read the collection directly and
 * cannot go stale.
 */
const dropStaleHits = async (docs, Model, idKey = '_id', visibilityFilter = {}) => {
    if (!Array.isArray(docs) || docs.length === 0) return docs || [];

    // Ids this check is entitled to judge. Anything absent or not an ObjectId
    // was never queried, so it is kept rather than silently dropped — the guard
    // must only ever remove hits it has positively disproved.
    const checkable = new Set();
    for (const doc of docs) {
        const raw = doc?.[idKey];
        if (!raw) continue;
        const key = String(raw);
        if (mongoose.Types.ObjectId.isValid(key)) checkable.add(key);
    }
    if (checkable.size === 0) return docs;

    const live = await Model.find({
        _id: { $in: [...checkable].map((id) => new mongoose.Types.ObjectId(id)) },
        ...visibilityFilter,
    }).select('_id').lean();
    const liveIds = new Set(live.map((row) => row._id.toString()));

    const kept = docs.filter((doc) => {
        const key = String(doc?.[idKey] ?? '');
        if (!checkable.has(key)) return true;
        return liveIds.has(key);
    });

    if (kept.length !== docs.length) {
        console.warn(
            `[search] dropped ${docs.length - kept.length} stale Typesense hit(s) ` +
            `for ${Model.modelName} — the typesense:sync worker is probably not running`
        );
    }
    return kept;
};

/**
 * Paid-only discovery for listings.
 *
 * Explore and searchAllContent already hide a Free business's product, service
 * and business posts from other people (filterBusinessPostsByPaymentPlan). The
 * dedicated product search did not, so the same listings were still findable
 * here. This applies the same rule, keeping it defined in one place.
 *
 * The seller's own listings are always kept: a Free seller must still find their
 * own products in search.
 *
 * Takes post rows that carry `userId` and `contentType`.
 */
const filterVisibleListings = async (rows, viewerId) => {
    if (!Array.isArray(rows) || rows.length === 0) return rows || [];

    const viewer = viewerId ? String(viewerId) : null;
    const isOwn = (row) => viewer !== null && String(row.userId?._id || row.userId) === viewer;

    const visibleToOthers = new Set(
        (await filterBusinessPostsByPaymentPlan(rows.filter((row) => !isOwn(row)))).map((row) => String(row._id))
    );
    return rows.filter((row) => isOwn(row) || visibleToOthers.has(String(row._id)));
};

/**
 * Sellers whose listings discovery hides: business accounts with no active plan.
 *
 * The product tab pages through results, so a seller has to be excluded INSIDE
 * the query. Dropping them from a page afterwards leaves short or empty pages,
 * and the app reads an empty page as the end of the results. The set is cached
 * for a minute because it is the same for every viewer.
 *
 * It is one id per unpaid business account. If that ever grows past what a
 * `$nin` list can carry, the plan status belongs on the search document itself.
 */
const HIDDEN_SELLERS_TTL_MS = 60 * 1000;
let hiddenSellersCache = { at: 0, ids: [] };

const getUnpaidSellerIds = async (viewerId) => {
    if (Date.now() - hiddenSellersCache.at > HIDDEN_SELLERS_TTL_MS) {
        try {
            const businessUsers = await User.find({ isBusinessProfile: true }).select('_id').lean();
            const ids = businessUsers.map((user) => String(user._id));
            const active = await bulkCheckActivePaymentPlans(ids);
            // bulkCheckActivePaymentPlans swallows its own errors and answers with
            // an empty map, which would read as "every seller is unpaid".
            if (ids.length > 0 && active.size === 0) throw new Error('plan lookup returned nothing');
            hiddenSellersCache = { at: Date.now(), ids: ids.filter((id) => active.get(id) !== true) };
        } catch (err) {
            // Fail open like Explore: a lookup failure must not blank the product
            // search. Keep the last known list and retry on the next request.
            console.error('getUnpaidSellerIds failed:', err.message);
        }
    }
    // A seller still finds their own listings.
    return viewerId ? hiddenSellersCache.ids.filter((id) => id !== String(viewerId)) : hiddenSellersCache.ids;
};

/**
 * Same rule for Typesense hits. A product card does not carry its seller, so the
 * posts are read back by id (one indexed query over at most `perPage` ids).
 * Cards whose post could not be found are kept: dropStaleHits owns that call.
 */
const dropUnpaidSellerHits = async (cards, viewerId) => {
    if (!Array.isArray(cards) || cards.length === 0) return cards || [];

    const ids = cards.map((card) => String(card?._id ?? '')).filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (ids.length === 0) return cards;

    const rows = await Post.find({ _id: { $in: ids } }).select('userId contentType').lean();
    const visible = new Set((await filterVisibleListings(rows, viewerId)).map((row) => String(row._id)));
    const judged = new Set(rows.map((row) => String(row._id)));

    return cards.filter((card) => {
        const key = String(card?._id ?? '');
        return !judged.has(key) || visible.has(key);
    });
};

/* --------------------------- MongoDB fallbacks ----------------------------- */

const mongoInstantFallback = async (query, blockedUsers, limit, viewerId) => {
    const rx = new RegExp('^' + escapeRegex(query), 'i'); // prefix match
    const [users, products] = await Promise.all([
        User.find({
            $or: [{ username: rx }, { fullName: rx }],
            accountStatus: 'active',
            _id: { $nin: blockedUsers },
        })
            .limit(limit)
            .select('username fullName profileImageUrl isBusinessProfile isBlueTickVerified')
            .lean(),
        Post.find({
            contentType: 'product',
            ...PUBLIC_POST_FILTER,
            $or: [
                { 'customization.product.name': rx },
                { 'customization.product.brand': rx },
                { 'customization.product.tags': rx },
            ],
        })
            .limit(limit)
            .select('customization.product media userId contentType')
            .lean(),
    ]);
    const visibleProducts = await filterVisibleListings(products, viewerId);

    return {
        users: users.map((u) => ({
            _id: u._id,
            username: u.username,
            fullName: u.fullName,
            profileImageUrl: u.profileImageUrl || null,
            isBusinessProfile: !!u.isBusinessProfile,
            isBlueTickVerified: !!u.isBlueTickVerified,
            isBusinessVerified: false,
            businessName: null,
            businessCategory: null,
        })),
        products: visibleProducts.map(postToProductCard),
    };
};

/* -------------------------------- endpoints -------------------------------- */

/**
 * GET /api/v1/users/search/instant?q=...&limit=6
 * Instant typeahead: matching profiles (name + photo) + products + keyword
 * completions, in one fast round trip. Falls back to Mongo if Typesense is off.
 */
export const instantSearch = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const limit = Math.min(toInt(req.query.limit, 6), 15);
    if (query.length < 1) throw new ApiError(400, "Search query 'q' is required");

    const blockedUsers = req.blockedUsers || [];

    // Keyword completions from popularity history (cheap prefix scan).
    const keywordsPromise = SearchSuggestion.find({
        keyword: { $regex: '^' + escapeRegex(query.toLowerCase()) },
    })
        .sort({ searchCount: -1, lastSearched: -1 })
        .limit(6)
        .select('keyword')
        .lean()
        .then((rows) => rows.map((r) => r.keyword))
        .catch(() => []);

    let data = null;
    if (isTypesenseEnabled) {
        try {
            data = await tsInstantSearch({
                q: query,
                blockedUserIds: blockedUsers,
                userLimit: limit,
                productLimit: limit,
            });
            // A stale index answers with deleted posts and departed accounts —
            // see dropStaleHits. If everything in the page turns out to be a
            // ghost the emptiness check below falls through to Mongo, which is
            // the right answer rather than a blank screen.
            if (data) {
                const [users, liveProducts] = await Promise.all([
                    dropStaleHits(data.users, User, '_id', VISIBLE_USER_FILTER),
                    dropStaleHits(data.products, Post, '_id', PUBLIC_POST_FILTER),
                ]);
                const products = await dropUnpaidSellerHits(liveProducts, req.user?._id);
                data = { ...data, users, products };
            }
        } catch (err) {
            console.error('instantSearch: Typesense failed, falling back to Mongo:', err.message);
        }
    }
    // Empty on BOTH sides means the index has nothing to say — see isEmptyTsResult.
    if (!data || (data.users.length === 0 && data.products.length === 0)) {
        data = await mongoInstantFallback(query, blockedUsers, limit, req.user?._id);
    }

    const keywords = await keywordsPromise;

    return res.status(200).json(
        new ApiResponse(200, { users: data.users, products: data.products, keywords }, 'Instant search results')
    );
});

/**
 * GET /api/v1/users/search/profiles?q=...&page=1&limit=20
 * Fast, typo-tolerant profile search ranked by relevance + followers.
 */
export const searchProfiles = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const page = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(toInt(req.query.limit, 20), 50);
    if (!query) throw new ApiError(400, "Search query 'q' is required");

    const blockedUsers = req.blockedUsers || [];

    if (isTypesenseEnabled) {
        try {
            const r = await tsSearchProfiles({ q: query, blockedUserIds: blockedUsers, page, perPage: limit });
            if (!isEmptyTsResult(r)) {
                // Accounts deleted, deactivated or banned since the last index
                // write — see dropStaleHits.
                const liveDocs = await dropStaleHits(r.docs, User, 'id', VISIBLE_USER_FILTER);
                const users = liveDocs.map((d) => ({
                    _id: d.id,
                    username: d.username,
                    fullName: d.fullName || null,
                    profileImageUrl: d.profileImageUrl || null,
                    bio: d.bio || null,
                    location: d.location || null,
                    isBusinessProfile: !!d.isBusinessProfile,
                    isBlueTickVerified: !!d.isBlueTickVerified,
                    isBusinessVerified: !!d.isBusinessVerified,
                    businessName: d.businessName || null,
                    businessCategory: d.businessCategory || null,
                    followersCount: d.followersCount || 0,
                }));
                // Every hit on this page was stale: fall through to Mongo rather
                // than answering "0 rows, total 3", which renders as a result
                // count with nothing under it. Mongo also searches bio and
                // location, so it may well have live matches the index missed.
                // Restricted to page 1 for the same reason as searchProducts —
                // see the note there.
                if (users.length > 0 || page > 1) {
                    // `r.found` still counts the hits that were just dropped;
                    // report what is actually deliverable so the total cannot
                    // promise rows that no longer exist.
                    const dropped = r.docs.length - users.length;
                    const total = Math.max(r.found - dropped, users.length);
                    return res.status(200).json(new ApiResponse(200, {
                        users,
                        pagination: {
                            page: r.page,
                            limit,
                            total,
                            totalPages: Math.ceil(total / limit),
                        },
                    }, 'Profile search results'));
                }
            }
        } catch (err) {
            console.error('searchProfiles: Typesense failed, falling back to Mongo:', err.message);
        }
    }

    // Mongo fallback — normalized to the same user shape as the Typesense path.
    const rx = new RegExp(escapeRegex(query), 'i');
    const filter = {
        $or: [{ username: rx }, { fullName: rx }, { bio: rx }, { location: rx }],
        accountStatus: 'active',
        _id: { $nin: blockedUsers },
    };
    const [rows, total] = await Promise.all([
        User.find(filter)
            .skip((page - 1) * limit)
            .limit(limit)
            .select('username fullName profileImageUrl bio location isBusinessProfile isBlueTickVerified')
            .lean(),
        User.countDocuments(filter),
    ]);
    const users = rows.map((u) => ({
        _id: u._id,
        username: u.username,
        fullName: u.fullName || null,
        profileImageUrl: u.profileImageUrl || null,
        bio: u.bio || null,
        location: u.location || null,
        isBusinessProfile: !!u.isBusinessProfile,
        isBlueTickVerified: !!u.isBlueTickVerified,
        isBusinessVerified: false,
        businessName: null,
        businessCategory: null,
        followersCount: 0,
    }));
    return res.status(200).json(new ApiResponse(200, {
        users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Profile search results'));
});

/**
 * GET /api/v1/users/search/products?q=...&category=&brand=&minPrice=&maxPrice=&city=&country=&lat=&lng=&radius=&sort=&page=&limit=
 * Fast product search with filters, facets and optional geo.
 */
export const searchProducts = asyncHandler(async (req, res) => {
    const query = (req.query.q || '').trim();
    const page = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(toInt(req.query.limit, 20), 50);

    const filters = {
        category: req.query.category || undefined,
        subcategory: req.query.subcategory || undefined,
        brand: req.query.brand || undefined,
        city: req.query.city || undefined,
        country: req.query.country || undefined,
        minPrice: toFloat(req.query.minPrice),
        maxPrice: toFloat(req.query.maxPrice),
    };
    const lat = toFloat(req.query.lat), lng = toFloat(req.query.lng);
    const geo = (Number.isFinite(lat) && Number.isFinite(lng))
        ? { lat, lng, radiusKm: toFloat(req.query.radius) || 25 }
        : null;

    // Blocked sellers and unpaid sellers are both excluded by author, so one
    // list serves the engine clause and the Mongo $nin alike.
    const blockedUsers = [
        ...(await resolveBlockedUsers(req)),
        ...(await getUnpaidSellerIds(req.user?._id)),
    ];

    if (isTypesenseEnabled) {
        try {
            const r = await tsSearchContent({
                q: query,
                contentType: 'product',
                filters,
                geo,
                page,
                perPage: limit,
                sortBy: req.query.sort || 'relevance',
                blockedUserIds: blockedUsers,
            });
            if (!isEmptyTsResult(r)) {
                // Products whose post has since been deleted, or which the
                // seller has since made private or archived — see dropStaleHits.
                // This is the Products tab, and a stale index is exactly what
                // made it read as "shows nothing relevant": the ghosts crowd out
                // the real listings and every one of them 404s when tapped.
                const liveProducts = await dropStaleHits(r.products, Post, '_id', PUBLIC_POST_FILTER);
                // The engine clause carries at most 500 ids, so this is the
                // safety net for any unpaid seller past that cap.
                const products = await dropUnpaidSellerHits(liveProducts, req.user?._id);
                // Every hit on this page was a ghost: fall through to the Mongo
                // path rather than answering with an empty page the user would
                // read as "no such product".
                //
                // ONLY on page 1. The two corpora are ranked differently
                // (Typesense _text_match/engagementScore vs the Mongo
                // _relevance/likes/createdAt stage below), so switching mid-run
                // makes `skip` mean something else entirely: Mongo's rows
                // 21-40 can repeat listings already shown from Typesense's page
                // 1, and the app appends pages without deduping. On a later
                // page an empty result is the honest answer — it ends
                // pagination instead of showing the user the same product twice.
                if (products.length > 0 || page > 1) {
                    // `found` is the engine's total, which still counts the
                    // hits just dropped; report what is actually deliverable so
                    // the page count cannot promise rows that do not exist.
                    // Typesense guarantees hits.length <= found, so this cannot
                    // go negative.
                    const dropped = r.products.length - products.length;
                    const total = Math.max(r.found - dropped, products.length);
                    return res.status(200).json(new ApiResponse(200, {
                        products,
                        facets: r.facets,
                        pagination: {
                            page: r.page,
                            limit,
                            total,
                            totalPages: Math.ceil(total / limit),
                        },
                    }, 'Product search results'));
                }
            }
        } catch (err) {
            console.error('searchProducts: Typesense failed, falling back to Mongo:', err.message);
        }
    }

    // Mongo fallback (no facets/typo tolerance) — same product-card shape + privacy guard.
    //* $match inside an aggregation does NOT run mongoose's caster, so a blocked
    //* id left as a string would compare unequal to every ObjectId and quietly
    //* exclude nobody. Cast up front; countDocuments below is happy either way.
    const blockedObjectIds = blockedUsers
        .map((id) => {
            try { return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id; }
            catch { return null; }
        })
        .filter(Boolean);
    const filter = { contentType: 'product', ...PUBLIC_POST_FILTER, userId: { $nin: blockedObjectIds } };
    const rx = query ? new RegExp(escapeRegex(query), 'i') : null;
    if (rx) {
        filter.$or = [
            { 'customization.product.name': rx },
            { 'customization.product.brand': rx },
            { 'customization.product.category': rx },
            { 'customization.product.subcategory': rx },
            { 'customization.product.tags': rx },
            { 'customization.product.description': rx },
            { caption: rx },
        ];
    }
    if (filters.category) filter['customization.product.category'] = filters.category;
    if (filters.subcategory) filter['customization.product.subcategory'] = filters.subcategory;
    if (filters.brand) filter['customization.product.brand'] = filters.brand;
    // Parity with the Typesense clauses above — these were accepted as query
    // params and then silently dropped whenever Typesense was unavailable.
    if (filters.city) filter['customization.product.location.city'] = filters.city;
    if (filters.country) filter['customization.product.location.country'] = filters.country;
    if (Number.isFinite(filters.minPrice) || Number.isFinite(filters.maxPrice)) {
        filter['customization.product.price'] = {};
        if (Number.isFinite(filters.minPrice)) filter['customization.product.price'].$gte = filters.minPrice;
        if (Number.isFinite(filters.maxPrice)) filter['customization.product.price'].$lte = filters.maxPrice;
    }

    // Sort mirrors the Typesense sortMap. `relevance` has no _text_match here, so
    // it is approximated with a name/brand/tag hit ranked above a caption-only or
    // description-only hit. Without this the fallback returned natural collection
    // order — for "shirt" that meant whatever happened to be inserted first, which
    // read as "product search is broken" on any environment without Typesense.
    const sortKey = req.query.sort || 'relevance';
    const relevanceStage = rx
        ? [{
            $addFields: {
                _relevance: {
                    $switch: {
                        branches: [
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.name', ''] }, regex: rx } }, then: 4 },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.brand', ''] }, regex: rx } }, then: 3 },
                            {
                                case: {
                                    $gt: [{
                                        $size: {
                                            $filter: {
                                                input: { $ifNull: ['$customization.product.tags', []] },
                                                as: 't',
                                                cond: { $regexMatch: { input: '$$t', regex: rx } },
                                            }
                                        }
                                    }, 0]
                                }, then: 3
                            },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.category', ''] }, regex: rx } }, then: 2 },
                            { case: { $regexMatch: { input: { $ifNull: ['$customization.product.subcategory', ''] }, regex: rx } }, then: 2 },
                        ],
                        default: 1,
                    }
                }
            }
        }]
        : [{ $addFields: { _relevance: 0 } }];

    const sortStage = {
        price_asc: { 'customization.product.price': 1 },
        price_desc: { 'customization.product.price': -1 },
        newest: { createdAt: -1 },
        popular: { 'engagement.likes': -1, createdAt: -1 },
    }[sortKey] || { _relevance: -1, 'engagement.likes': -1, createdAt: -1 };

    const [posts, total] = await Promise.all([
        Post.aggregate([
            { $match: filter },
            ...relevanceStage,
            { $sort: sortStage },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            //* Join the seller so this path returns the SAME card as Typesense.
            //* It was skipped as "not cheap", but it runs after $limit — at most
            //* `limit` lookups — and without it every product card rendered with
            //* a blank seller name whenever Typesense was unavailable.
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: '_author',
                    pipeline: [{ $project: { username: 1, profileImageUrl: 1 } }],
                }
            },
            { $project: { 'customization.product': 1, media: 1, userId: 1, contentType: 1, _author: 1 } },
        ]),
        Post.countDocuments(filter),
    ]);
    return res.status(200).json(new ApiResponse(200, {
        products: posts.map(postToProductCard),
        facets: [],
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, 'Product search results'));
});
