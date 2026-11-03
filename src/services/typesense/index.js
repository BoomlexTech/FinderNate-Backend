import { typesenseClient, isTypesenseEnabled } from '../../config/typesense.config.js';
import {
    USERS_COLLECTION,
    POSTS_COLLECTION,
    usersSchema,
    postsSchema,
    userToDoc,
    postToDoc,
} from './schemas.js';

/**
 * High-level Typesense service: collection lifecycle, indexing, and search.
 *
 * Read helpers (instantSearch/searchProfiles/searchContent) return null when
 * Typesense is disabled so controllers fall back to MongoDB.
 *
 * Write helpers (indexUser/indexPost/removeDoc) are no-ops when disabled, but when
 * enabled they PROPAGATE errors to the caller (the sync worker) so it can avoid
 * advancing its resume token past a write that never landed. Do not swallow here.
 */

const SCHEMAS = [usersSchema, postsSchema];

/* ----------------------------- collection setup ---------------------------- */

const collectionExists = async (name) => {
    try {
        await typesenseClient.collections(name).retrieve();
        return true;
    } catch (err) {
        if (err.httpStatus === 404) return false;
        throw err;
    }
};

/** Create any missing collections. Idempotent. Safe to call on every boot. */
export const ensureCollections = async () => {
    if (!isTypesenseEnabled) return;
    for (const schema of SCHEMAS) {
        if (!(await collectionExists(schema.name))) {
            await typesenseClient.collections().create(schema);
            console.log(`🔎 Typesense: created collection "${schema.name}"`);
            continue;
        }
        // Add fields introduced after the collection was created (e.g.
        // posts.subcategories, Phase 2 #17). Existing documents pick the new
        // field up when they are next re-indexed.
        try {
            const live = await typesenseClient.collections(schema.name).retrieve();
            const have = new Set((live.fields || []).map((f) => f.name));
            const missing = schema.fields.filter((f) => !have.has(f.name));
            if (missing.length) {
                await typesenseClient.collections(schema.name).update({ fields: missing });
                console.log(`🔎 Typesense: added ${missing.map((f) => f.name).join(', ')} to "${schema.name}"`);
            }
        } catch (err) {
            console.warn(`🔎 Typesense: could not update "${schema.name}" schema: ${err?.message}`);
        }
    }
};

/** Drop and recreate all collections (destructive — used by bootstrap --force). */
export const recreateCollections = async () => {
    if (!isTypesenseEnabled) throw new Error('Typesense is not enabled');
    for (const schema of SCHEMAS) {
        if (await collectionExists(schema.name)) {
            await typesenseClient.collections(schema.name).delete();
            console.log(`🔎 Typesense: dropped collection "${schema.name}"`);
        }
        await typesenseClient.collections().create(schema);
        console.log(`🔎 Typesense: created collection "${schema.name}"`);
    }
};

/* -------------------------------- indexing --------------------------------- */
/* These THROW on failure when enabled — the sync worker depends on that to gate
   its resume token. Callers that want fire-and-forget must catch themselves.    */

export const indexUser = async (user, business = null) => {
    if (!isTypesenseEnabled) return;
    const doc = userToDoc(user, business);
    if (!doc) return;
    await typesenseClient.collections(USERS_COLLECTION).documents().upsert(doc);
};

export const indexPost = async (post, author = null) => {
    if (!isTypesenseEnabled) return;
    const doc = postToDoc(post, author);
    if (!doc) return;
    await typesenseClient.collections(POSTS_COLLECTION).documents().upsert(doc);
};

export const removeDoc = async (collection, id) => {
    if (!isTypesenseEnabled || !id) return;
    try {
        await typesenseClient.collections(collection).documents(String(id)).delete();
    } catch (err) {
        if (err.httpStatus === 404) return; // already gone = success
        throw err;
    }
};

export const removeUser = (id) => removeDoc(USERS_COLLECTION, id);
export const removePost = (id) => removeDoc(POSTS_COLLECTION, id);

/**
 * Bulk import documents (used by the backfill script). Returns {success, failed}.
 * throwOnFail:false so a single bad document doesn't abort the whole batch — we
 * count per-line results instead.
 */
export const importDocs = async (collection, docs) => {
    if (!isTypesenseEnabled || docs.length === 0) return { success: 0, failed: 0 };
    const results = await typesenseClient
        .collections(collection)
        .documents()
        .import(docs, { action: 'upsert', return_id: true, throwOnFail: false });
    let success = 0, failed = 0;
    for (const r of results) {
        if (r.success) success++;
        else { failed++; if (failed <= 5) console.error('  import error:', r.error); }
    }
    return { success, failed };
};

/* --------------------------------- search ---------------------------------- */

/** Wrap a string exact-match value for filter_by, escaping backticks. */
const exact = (field, value) => `${field}:=\`${String(value).replace(/`/g, '')}\``;

/**
 * Build a `&& <field>:!=[...]` clause to exclude blocked users at the engine level
 * so `found` stays accurate and pages aren't short. Capped to keep the filter sane.
 *
 * The field differs by collection: a blocked person is the DOCUMENT in "users"
 * (`id`) but the AUTHOR in "posts" (`userId`). Product searches used no clause at
 * all, so a blocked seller's listings kept showing up in instant search and in the
 * product tab even though their profile was correctly hidden.
 */
const blockedClause = (ids, field = 'id') => {
    const list = (ids || []).map(String).filter((s) => /^[a-fA-F0-9]{24}$/.test(s)).slice(0, 500);
    return list.length ? ` && ${field}:!=[${list.join(',')}]` : '';
};

/** Throw if any sub-search in a multi_search returned a per-search error (HTTP 200 masks these). */
const assertNoSubError = (results) => {
    const bad = (results || []).find((r) => r && (r.error || (typeof r.code === 'number' && r.code >= 400)));
    if (bad) throw new Error(`Typesense multi_search sub-error: ${bad.error || bad.code}`);
};

const PRODUCT_CARD_FIELDS = 'id,title,image,price,currency,category,subcategory,brand,tags,locationCity,username,userProfileImageUrl,contentType';

const toProductCard = (d) => ({
    _id: d.id,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    subcategories: d.subcategories || [],
    name: d.title || null,
    image: d.image || null,
    price: d.price ?? null,
    currency: d.currency || null,
    category: d.category || null,
    subcategory: d.subcategory || null,
    brand: d.brand || null,
    tags: d.tags || [],
    locationCity: d.locationCity || null,
    username: d.username || null,
    userProfileImageUrl: d.userProfileImageUrl || null,
    contentType: d.contentType || null,
});

/**
 * Instant multi-search for the typeahead: users + products in ONE round trip.
 * Returns { users, products } shaped for the suggestion dropdown (name + photo).
 */
export const instantSearch = async ({ q, blockedUserIds = [], userLimit = 6, productLimit = 6 }) => {
    if (!isTypesenseEnabled) return null;
    const query = (q || '').trim();
    if (!query) return { users: [], products: [] };

    const searches = [
        {
            collection: USERS_COLLECTION,
            q: query,
            query_by: 'username,fullName,businessName',
            query_by_weights: '4,2,2',
            prefix: true,
            num_typos: 1,
            per_page: userLimit,
            sort_by: '_text_match:desc,followersCount:desc',
            filter_by: 'accountStatus:=active' + blockedClause(blockedUserIds),
            include_fields: 'id,username,fullName,profileImageUrl,isBusinessProfile,isBlueTickVerified,isBusinessVerified,businessName,businessCategory',
        },
        {
            collection: POSTS_COLLECTION,
            q: query,
            query_by: 'title,brand,tags,hashtags,category,caption,description',
            query_by_weights: '6,4,4,3,3,2,1',
            prefix: true,
            num_typos: 1,
            per_page: productLimit,
            filter_by: 'isPublic:=true && contentType:=product' + blockedClause(blockedUserIds, 'userId'),
            sort_by: '_text_match:desc,engagementScore:desc',
            include_fields: PRODUCT_CARD_FIELDS,
        },
    ];

    const { results } = await typesenseClient.multiSearch.perform({ searches });
    assertNoSubError(results);

    const users = (results[0]?.hits || []).map((h) => {
        const d = h.document;
        return {
            _id: d.id,
            username: d.username,
            fullName: d.fullName,
            profileImageUrl: d.profileImageUrl || null,
            isBusinessProfile: !!d.isBusinessProfile,
            isBlueTickVerified: !!d.isBlueTickVerified,
            isBusinessVerified: !!d.isBusinessVerified,
            businessName: d.businessName || null,
            businessCategory: d.businessCategory || null,
        };
    });

    const products = (results[1]?.hits || []).map((h) => toProductCard(h.document));

    return { users, products };
};

/**
 * Full profile search (paginated). Blocked users are excluded in-engine so `found`
 * is accurate. Returns { ids, docs, found, page }.
 */
export const searchProfiles = async ({ q, blockedUserIds = [], page = 1, perPage = 20 }) => {
    if (!isTypesenseEnabled) return null;
    const query = (q || '').trim();
    if (!query) return { ids: [], docs: [], found: 0, page: 1 };

    const res = await typesenseClient.collections(USERS_COLLECTION).documents().search({
        q: query,
        query_by: 'username,fullName,businessName,bio,businessCategory,location',
        query_by_weights: '5,4,3,1,2,1',
        prefix: true,
        num_typos: 2,
        page,
        per_page: perPage,
        sort_by: '_text_match:desc,followersCount:desc',
        filter_by: 'accountStatus:=active' + blockedClause(blockedUserIds),
    });

    const hits = res.hits || [];
    return {
        ids: hits.map((h) => h.document.id),
        docs: hits.map((h) => h.document),
        found: res.found,
        page: res.page,
    };
};

/**
 * Product / content search with filters, facets and optional geo.
 * Returns { products, ids, found, page, facets }.
 */
export const searchContent = async ({
    q, contentType = 'product', filters = {}, geo = null, page = 1, perPage = 20, sortBy = 'relevance',
    blockedUserIds = [],
}) => {
    if (!isTypesenseEnabled) return null;
    const query = (q || '').trim() || '*';

    const filterClauses = ['isPublic:=true'];
    // Blocked in either direction — neither party sees the other's listings.
    const blocked = blockedClause(blockedUserIds, 'userId');
    if (blocked) filterClauses.push(blocked.replace(/^ && /, ''));
    if (contentType) filterClauses.push(exact('contentType', contentType));
    if (filters.category) filterClauses.push(exact('category', filters.category));
    if (filters.subcategory) filterClauses.push(`(${exact('subcategory', filters.subcategory)} || ${exact('subcategories', filters.subcategory)})`);
    if (filters.brand) filterClauses.push(exact('brand', filters.brand));
    if (filters.city) filterClauses.push(exact('locationCity', filters.city));
    if (filters.country) filterClauses.push(exact('locationCountry', filters.country));
    if (Number.isFinite(filters.minPrice)) filterClauses.push(`price:>=${filters.minPrice}`);
    if (Number.isFinite(filters.maxPrice)) filterClauses.push(`price:<=${filters.maxPrice}`);
    const hasGeo = geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng);
    if (hasGeo) {
        const radius = Number.isFinite(geo.radiusKm) ? geo.radiusKm : 25;
        filterClauses.push(`geo:(${geo.lat}, ${geo.lng}, ${radius} km)`);
    }

    const sortMap = {
        relevance: '_text_match:desc,engagementScore:desc',
        price_asc: 'price:asc',
        price_desc: 'price:desc',
        newest: 'createdAt:desc',
        popular: 'engagementScore:desc,createdAt:desc',
    };
    let sort_by = sortMap[sortBy] || sortMap.relevance;
    // Geo filter guarantees every candidate has a geopoint, so a geo sort is safe.
    if (hasGeo && sortBy === 'relevance') sort_by = `geo(${geo.lat}, ${geo.lng}):asc,_text_match:desc`;

    const res = await typesenseClient.collections(POSTS_COLLECTION).documents().search({
        q: query,
        query_by: 'title,brand,tags,hashtags,category,subcategory,subcategories,caption,description',
        query_by_weights: '6,4,4,3,3,3,3,2,1',
        prefix: true,
        num_typos: 2,
        page,
        per_page: perPage,
        filter_by: filterClauses.join(' && '),
        sort_by,
        facet_by: 'category,brand,contentType,locationCity',
        max_facet_values: 20,
    });

    const hits = res.hits || [];
    return {
        products: hits.map((h) => toProductCard(h.document)),
        ids: hits.map((h) => h.document.id),
        found: res.found,
        page: res.page,
        facets: res.facet_counts || [],
    };
};
