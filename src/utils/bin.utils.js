import mongoose from 'mongoose';
import BinItem from '../models/binItem.models.js';
import Post from '../models/userPost.models.js';
import Story from '../models/story.models.js';
import Like from '../models/like.models.js';
import Comment from '../models/comment.models.js';
import SavedPost from '../models/savedPost.models.js';
import PostInteraction from '../models/postInteraction.models.js';
import Report from '../models/report.models.js';
import PaymentLink from '../models/paymentLink.models.js';
import StoryComment from '../models/storyComment.models.js';
import { deleteMultipleFromBunny } from './bunny.js';
import { cancelBoostsForPost } from './boostServing.js';
import { getSettingValue } from './appSettings.utils.js';
import { binPreviewOf, mediaUrlsOf, restoredStoryState } from './bin.rules.js';

export { binPreviewOf, mediaUrlsOf, restoredStoryState };

/**
 * The Bin (Phase 2 #15). See models/binItem.models.js for the design.
 */
export const DEFAULT_BIN_RETENTION_DAYS = 15;
const DAY = 24 * 60 * 60 * 1000;

export const retentionDays = async () => {
    const days = Number(await getSettingValue('BIN_RETENTION_DAYS', DEFAULT_BIN_RETENTION_DAYS));
    return Number.isFinite(days) && days >= 1 && days <= 90 ? days : DEFAULT_BIN_RETENTION_DAYS;
};

/**
 * Move a post or story into the Bin and out of its collection. The caller has
 * already checked ownership.
 */
export const moveToBin = async (kind, doc, userId) => {
    const raw = doc.toObject ? doc.toObject({ depopulate: true, virtuals: false }) : { ...doc };
    const days = await retentionDays();
    const item = await BinItem.findOneAndUpdate(
        { originalId: raw._id },
        {
            $setOnInsert: {
                userId,
                kind,
                originalId: raw._id,
                doc: raw,
                preview: binPreviewOf(kind, raw),
                deletedAt: new Date(),
                purgeAfter: new Date(Date.now() + days * DAY),
            },
        },
        { upsert: true, new: true },
    );
    if (kind === 'post') {
        await Post.deleteOne({ _id: raw._id });
        await mongoose.model('User').updateOne({ _id: userId }, { $pull: { posts: raw._id } });
    } else {
        await Story.deleteOne({ _id: raw._id });
    }
    return item;
};

/** Put a binned item back under its original id. */
export const restoreFromBin = async (item) => {
    const doc = { ...item.doc };
    if (item.kind === 'post') {
        await Post.collection.insertOne(doc);
        await mongoose.model('User').updateOne({ _id: item.userId }, { $addToSet: { posts: doc._id } });
    } else {
        Object.assign(doc, restoredStoryState(doc));
        await Story.collection.insertOne(doc);
    }
    await BinItem.deleteOne({ _id: item._id });
    return doc;
};

/** Delete a binned item for good: its media, then everything that points at it. */
export const purgeBinItem = async (item) => {
    const urls = mediaUrlsOf(item.kind, item.doc || {});
    if (urls.length) await deleteMultipleFromBunny(urls);
    const id = item.originalId;
    if (item.kind === 'post') {
        await Promise.allSettled([
            Like.deleteMany({ postId: id }),
            Comment.deleteMany({ postId: id }),
            SavedPost.deleteMany({ postId: id }),
            PostInteraction.deleteMany({ postId: id }),
            Report.deleteMany({ reportedPostId: id }),
            PaymentLink.updateMany({ postId: id, status: 'active' }, { $set: { status: 'cancelled' } }),
            cancelBoostsForPost(id),
        ]);
    } else {
        await StoryComment.deleteMany({ storyId: id });
    }
    await BinItem.deleteOne({ _id: item._id });
};
