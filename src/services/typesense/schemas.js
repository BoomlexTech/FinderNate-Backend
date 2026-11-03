/**
 * Typesense collection schemas + MongoDB -> Typesense document mappers.
 *
 * Two collections:
 *   - "users"  : profiles (User + optional 1:1 Business) — powers instant autocomplete
 *                with username + profile photo, and full profile search.
 *   - "posts"  : all Post documents (contentType normal/product/service/business).
 *                Product search = this collection filtered by contentType:=product.
 *
 * Design notes:
 *   - We only store what we need to RANK/FILTER/DISPLAY-in-suggestions. Full documents
 *     are hydrated from MongoDB after retrieval so business/payment rules stay live.
 *   - `index: false` fields are stored & returned but not searchable (display-only).
 *   - default_sorting_field must be a numeric field present on every doc.
 */

export const USERS_COLLECTION = 'users';
export const POSTS_COLLECTION = 'posts';

export const usersSchema = {
    name: USERS_COLLECTION,
    enable_nested_fields: false,
    fields: [
        { name: 'username', type: 'string' },
        { name: 'fullName', type: 'string', optional: true },
        { name: 'bio', type: 'string', optional: true },
        { name: 'profileImageUrl', type: 'string', optional: true, index: false },
        { name: 'isBusinessProfile', type: 'bool', facet: true },
        { name: 'isBlueTickVerified', type: 'bool', optional: true },
        { name: 'isBusinessVerified', type: 'bool', optional: true },
        { name: 'businessName', type: 'string', optional: true },
        { name: 'businessCategory', type: 'string', optional: true, facet: true },
        { name: 'location', type: 'string', optional: true },
        { name: 'followersCount', type: 'int32' },
        { name: 'accountStatus', type: 'string', facet: true },
        { name: 'createdAt', type: 'int64' },
    ],
    default_sorting_field: 'followersCount',
};

export const postsSchema = {
    name: POSTS_COLLECTION,
    enable_nested_fields: false,
    fields: [
        { name: 'userId', type: 'string', facet: true },
        { name: 'username', type: 'string', optional: true },
        { name: 'userProfileImageUrl', type: 'string', optional: true, index: false },
        { name: 'contentType', type: 'string', facet: true },   // normal | product | service | business
        { name: 'postType', type: 'string', facet: true, optional: true },
        { name: 'caption', type: 'string', optional: true },
        { name: 'description', type: 'string', optional: true },
        { name: 'hashtags', type: 'string[]', optional: true, facet: true },
        { name: 'title', type: 'string', optional: true },       // product/service/business name (unified)
        { name: 'brand', type: 'string', optional: true, facet: true },
        { name: 'category', type: 'string', optional: true, facet: true },
        { name: 'subcategory', type: 'string', optional: true, facet: true },
        // Phase 2 #17: every subcategory of the post (up to 10).
        { name: 'subcategories', type: 'string[]', optional: true, facet: true },
        { name: 'tags', type: 'string[]', optional: true, facet: true },
        { name: 'price', type: 'float', optional: true },
        { name: 'currency', type: 'string', optional: true },
        { name: 'image', type: 'string', optional: true, index: false },
        { name: 'locationCity', type: 'string', optional: true, facet: true },
        { name: 'locationCountry', type: 'string', optional: true, facet: true },
        { name: 'geo', type: 'geopoint', optional: true },       // [lat, lng]
        { name: 'isPublic', type: 'bool', facet: true },
        { name: 'engagementScore', type: 'float' },
        { name: 'createdAt', type: 'int64' },
    ],
    default_sorting_field: 'engagementScore',
};

/* --------------------------------- helpers -------------------------------- */

const toId = (v) => (v == null ? undefined : v.toString());
const toEpoch = (d) => {
    const t = d ? new Date(d).getTime() : NaN;
    return Number.isFinite(t) ? t : 0;
};
const str = (v) => (v == null ? undefined : String(v));

/** Mongo GeoJSON coordinates are [lng, lat]; Typesense geopoint wants [lat, lng]. */
const toGeopoint = (coordsField) => {
    const c = coordsField?.coordinates;
    if (Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
        const [lng, lat] = c;
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)) {
            return [lat, lng];
        }
    }
    return undefined;
};

/** Drop undefined keys so Typesense optional fields behave correctly. */
const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        out[k] = v;
    }
    return out;
};

/**
 * Map a User (+ optional Business) to a "users" Typesense doc.
 * @param {object} user     lean User document
 * @param {object} [business] lean Business document for this user (optional)
 */
export const userToDoc = (user, business = null) => {
    if (!user?._id) return null;
    return clean({
        id: toId(user._id),
        username: str(user.username),
        fullName: str(user.fullName),
        bio: str(user.bio),
        profileImageUrl: str(user.profileImageUrl),
        isBusinessProfile: Boolean(user.isBusinessProfile),
        isBlueTickVerified: Boolean(user.isBlueTickVerified),
        isBusinessVerified: business ? Boolean(business.isVerified) : undefined,
        businessName: business ? str(business.businessName) : undefined,
        businessCategory: business ? str(business.category) : undefined,
        // "Hide address" on the profile covers the free-text location too: a
        // hidden location must not be searchable or shown in search results.
        location: user.isAddressHidden ? undefined : str(user.location),
        followersCount: Array.isArray(user.followers) ? user.followers.length : 0,
        accountStatus: str(user.accountStatus) || 'active',
        createdAt: toEpoch(user.createdAt),
    });
};

/**
 * Map a Post to a "posts" Typesense doc.
 * @param {object} post   lean Post document
 * @param {object} [author] lean User (author) for denormalized username/photo (optional)
 */
export const postToDoc = (post, author = null) => {
    if (!post?._id) return null;

    const c = post.customization || {};
    const product = c.product || {};
    const service = c.service || {};
    const bizInPost = c.business || {};
    const normal = c.normal || {};

    // Unified display/search fields by contentType
    const title =
        str(product.name) || str(service.name) || str(bizInPost.businessName) || undefined;
    const category =
        str(product.category) || str(service.category) || str(bizInPost.category) || undefined;
    const subcategory =
        str(product.subcategory) || str(service.subcategory) || str(bizInPost.subcategory) || undefined;
    const tags = [
        ...(Array.isArray(product.tags) ? product.tags : []),
        ...(Array.isArray(service.tags) ? service.tags : []),
        ...(Array.isArray(bizInPost.tags) ? bizInPost.tags : []),
        ...(Array.isArray(normal.tags) ? normal.tags : []),
    ].map(str).filter(Boolean);

    const price = Number.isFinite(product.price) ? product.price
        : Number.isFinite(service.price) ? service.price : undefined;

    const image =
        (Array.isArray(product.images) && product.images[0]) ||
        (Array.isArray(post.media) && (post.media[0]?.thumbnailUrl || post.media[0]?.url)) ||
        undefined;

    // Location (city/country + geopoint) from whichever customization block has it
    const locBlock = product.location || service.location || bizInPost.location || normal.location || {};
    const geo = toGeopoint(locBlock.coordinates);

    // engagement weighting mirrors the legacy in-JS scoring (retrieval-time signal only;
    // contentType base boost + paid-business boost are applied live in the controller).
    const e = post.engagement || {};
    const engagementScore =
        (e.likes || 0) * 1 +
        (e.comments || 0) * 0.7 +
        (e.views || 0) * 0.5 +
        (e.shares || 0) * 0.5;

    const privacy = post.settings?.privacy;
    const status = post.status;
    const isPublic = privacy !== 'private' && status !== 'draft' && status !== 'archived';

    return clean({
        id: toId(post._id),
        userId: toId(post.userId?._id || post.userId),
        username: author ? str(author.username) : undefined,
        userProfileImageUrl: author ? str(author.profileImageUrl) : undefined,
        contentType: str(post.contentType) || 'normal',
        postType: str(post.postType),
        caption: str(post.caption),
        description: str(post.description),
        hashtags: (Array.isArray(post.hashtags) ? post.hashtags : []).map(str).filter(Boolean),
        title,
        brand: str(product.brand),
        category,
        subcategory: subcategory || str(post.subcategories?.[0]),
        subcategories: [...new Set([
            ...(Array.isArray(post.subcategories) ? post.subcategories : []),
            ...(subcategory ? [subcategory] : []),
        ].map(str).filter(Boolean))],
        tags,
        price,
        currency: str(product.currency) || str(service.currency),
        image,
        locationCity: str(locBlock.city),
        locationCountry: str(locBlock.country),
        geo,
        isPublic,
        engagementScore,
        createdAt: toEpoch(post.createdAt),
    });
};
