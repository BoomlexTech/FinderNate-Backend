import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import SaveCollection from '../models/saveCollection.models.js';
import SavedPost from '../models/savedPost.models.js';
import Post from '../models/userPost.models.js';
import { assertCanViewPostById } from './post/visibility.js';

/**
 * Private named collections of saved posts (Phase 2 #54). Only the owner can
 * see or change them; listing a collection's posts goes through
 * GET /posts/saved?collectionId=.
 */

export const MAX_COLLECTIONS = 100;

/** Trimmed, single-spaced, 1..50 characters, or null. Pure. */
export const normalizeCollectionName = (name) => {
    if (typeof name !== 'string') return null;
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 50) return null;
    return clean;
};

const ownCollection = async (collectionId, userId) => {
    if (!mongoose.Types.ObjectId.isValid(String(collectionId))) throw new ApiError(404, 'Collection not found');
    const collection = await SaveCollection.findOne({ _id: collectionId, userId });
    if (!collection) throw new ApiError(404, 'Collection not found');
    return collection;
};

const coverOf = (post) => {
    const m = post?.media?.[0];
    return m ? (m.thumbnailUrl || (m.type === 'image' ? m.url : null)) : null;
};

/** GET /posts/collections — every collection with its count and up to 4 covers. */
export const listCollections = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const [collections, totals, allSaved] = await Promise.all([
        SaveCollection.find({ userId }).sort({ updatedAt: -1 }).lean(),
        SavedPost.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(String(userId)), collectionIds: { $exists: true, $ne: [] } } },
            { $sort: { savedAt: -1 } },
            { $unwind: '$collectionIds' },
            { $group: { _id: '$collectionIds', count: { $sum: 1 }, postIds: { $push: '$postId' } } },
            { $project: { count: 1, postIds: { $slice: ['$postIds', 4] } } },
        ]),
        SavedPost.find({ userId }).sort({ savedAt: -1 }).limit(4).select('postId').lean()
            .then(async (rows) => ({ rows, count: await SavedPost.countDocuments({ userId }) })),
    ]);

    const byId = new Map(totals.map((t) => [String(t._id), t]));
    const coverIds = [...new Set([...totals.flatMap((t) => t.postIds), ...allSaved.rows.map((r) => r.postId)].map(String))];
    const posts = coverIds.length ? await Post.find({ _id: { $in: coverIds } }).select('media').lean() : [];
    const coverById = new Map(posts.map((p) => [String(p._id), coverOf(p)]));
    const covers = (ids) => ids.map((id) => coverById.get(String(id))).filter(Boolean);

    return res.status(200).json(new ApiResponse(200, {
        allSaved: { count: allSaved.count, covers: covers(allSaved.rows.map((r) => r.postId)) },
        collections: collections.map((c) => {
            const t = byId.get(String(c._id));
            return { _id: c._id, name: c.name, count: t?.count || 0, covers: covers(t?.postIds || []), updatedAt: c.updatedAt };
        }),
    }, 'Collections fetched'));
});

/** POST /posts/collections { name, postId? } */
export const createCollection = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const name = normalizeCollectionName(req.body?.name);
    if (!name) throw new ApiError(400, 'Give the collection a name of up to 50 characters');
    if (await SaveCollection.countDocuments({ userId }) >= MAX_COLLECTIONS) {
        throw new ApiError(400, `You can have up to ${MAX_COLLECTIONS} collections`);
    }
    let collection;
    try {
        collection = await SaveCollection.create({ userId, name, nameKey: name.toLowerCase() });
    } catch (err) {
        if (err?.code === 11000) throw new ApiError(409, 'You already have a collection with that name');
        throw err;
    }

    // Optionally save a post straight into it ("New collection" in Save to…).
    const { postId } = req.body || {};
    if (postId) {
        await assertCanViewPostById(postId, userId);
        await SavedPost.updateOne(
            { userId, postId },
            { $setOnInsert: { userId, postId, savedAt: new Date() }, $addToSet: { collectionIds: collection._id } },
            { upsert: true },
        );
    }
    return res.status(201).json(new ApiResponse(201, collection, 'Collection created'));
});

/** PATCH /posts/collections/:collectionId { name } */
export const renameCollection = asyncHandler(async (req, res) => {
    const collection = await ownCollection(req.params.collectionId, req.user._id);
    const name = normalizeCollectionName(req.body?.name);
    if (!name) throw new ApiError(400, 'Give the collection a name of up to 50 characters');
    collection.name = name;
    collection.nameKey = name.toLowerCase();
    try {
        await collection.save();
    } catch (err) {
        if (err?.code === 11000) throw new ApiError(409, 'You already have a collection with that name');
        throw err;
    }
    return res.status(200).json(new ApiResponse(200, collection, 'Collection renamed'));
});

/** DELETE /posts/collections/:collectionId — the posts stay saved. */
export const deleteCollection = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const collection = await ownCollection(req.params.collectionId, userId);
    await SavedPost.updateMany({ userId, collectionIds: collection._id }, { $pull: { collectionIds: collection._id } });
    await collection.deleteOne();
    return res.status(200).json(new ApiResponse(200, { collectionId: collection._id }, 'Collection deleted. The posts are still in your saved items.'));
});

/** POST /posts/collections/:collectionId/posts { postId } — saves it if needed. */
export const addToCollection = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const collection = await ownCollection(req.params.collectionId, userId);
    const { postId } = req.body || {};
    await assertCanViewPostById(postId, userId);
    await SavedPost.updateOne(
        { userId, postId },
        { $setOnInsert: { userId, postId, savedAt: new Date() }, $addToSet: { collectionIds: collection._id } },
        { upsert: true },
    );
    collection.updatedAt = new Date();
    await collection.save();
    return res.status(200).json(new ApiResponse(200, { collectionId: collection._id, postId, isSaved: true }, `Saved to ${collection.name}`));
});

/** DELETE /posts/collections/:collectionId/posts/:postId — stays saved. */
export const removeFromCollection = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const collection = await ownCollection(req.params.collectionId, userId);
    const { postId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(postId)) throw new ApiError(404, 'Post not found');
    await SavedPost.updateOne({ userId, postId }, { $pull: { collectionIds: collection._id } });
    return res.status(200).json(new ApiResponse(200, { collectionId: collection._id, postId }, `Removed from ${collection.name}`));
});
