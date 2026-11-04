import mongoose from 'mongoose';
import Business from '../models/business.models.js';
import Follower from '../models/follower.models.js';
import PaidListing from '../models/paidListing.models.js';
import { User } from '../models/user.models.js';
import { getSettingValue } from './appSettings.utils.js';
import { COMMERCIAL_TYPES, TIERS, visibilityTier, effectiveKycStatus, canSeeCommercial, premiumFirst } from './phase4.rules.js';

/**
 * Who can see product, service and business posts (Phase 4 #74, #78, #80).
 *
 * Business accounts: by KYC and plan (see visibilityTier).
 * Regular accounts: their product and service posts reach discovery only with
 * an active paid listing (#80); their followers still see them.
 * Ordinary posts (photos, vibes, notes) are never affected.
 *
 * The admin setting KYC_VISIBILITY_MODE = 'legacy' switches back to the
 * pre-Phase 4 rule (an active plan is enough), in case it's needed.
 */
const idOf = (p) => String(p?.userId?._id || p?.userId || '');

/** Tier per author id, for the given ids. */
export const tiersFor = async (userIds) => {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!ids.length) return { tiers: new Map(), business: new Set() };
    const [users, businesses] = await Promise.all([
        User.find({ _id: { $in: ids }, isBusinessProfile: true }).select('_id').lean(),
        Business.find({ userId: { $in: ids } }).select('userId plan subscriptionStatus verificationStatus kyc').lean(),
    ]);
    const business = new Set(users.map((u) => String(u._id)));
    const legacy = (await getSettingValue('KYC_VISIBILITY_MODE', 'enforce')) === 'legacy';
    const tiers = new Map();
    for (const b of businesses) {
        const kycStatus = legacy ? 'verified' : effectiveKycStatus(b);
        let tier = visibilityTier({ kycStatus, plan: b.plan, subscriptionStatus: b.subscriptionStatus });
        if (legacy && tier === TIERS.NETWORK) tier = TIERS.HIDDEN; // legacy: no plan, no discovery
        tiers.set(String(b.userId), tier);
    }
    for (const id of business) if (!tiers.has(id)) tiers.set(id, TIERS.HIDDEN);
    return { tiers, business };
};

/** Authors the viewer follows or who follow the viewer. */
const connectionsOf = async (viewerId, authorIds) => {
    if (!viewerId || !authorIds.length) return new Set();
    const rows = await Follower.find({
        $or: [
            { followerId: viewerId, userId: { $in: authorIds } },
            { userId: viewerId, followerId: { $in: authorIds } },
        ],
    }).select('userId followerId').lean();
    const set = new Set();
    for (const r of rows) set.add(String(r.followerId) === String(viewerId) ? String(r.userId) : String(r.followerId));
    return set;
};

/** Posts by regular users that have an active paid listing. */
const activeListingPostIds = async (postIds) => {
    if (!postIds.length) return new Set();
    const rows = await PaidListing.find({ postId: { $in: postIds }, status: 'active', endsAt: { $gt: new Date() } }).select('postId').lean();
    return new Set(rows.map((r) => String(r.postId)));
};

/**
 * Filters a list of posts for one viewer. `context` is 'discovery' (explore,
 * search, trending: regular users' product posts need a listing) or 'feed'
 * (home feed and profile: followers see them anyway).
 * Premium authors' commercial posts come first unless `keepOrder` is set.
 */
export const filterCommercialPosts = async (posts, viewerId = null, { context = 'discovery', keepOrder = false } = {}) => {
    if (!posts?.length) return posts || [];
    try {
        const commercial = posts.filter((p) => COMMERCIAL_TYPES.has(p.contentType));
        if (!commercial.length) return posts;
        const authorIds = [...new Set(commercial.map(idOf).filter(Boolean))];
        const { tiers, business } = await tiersFor(authorIds);
        const viewer = viewerId ? String(viewerId) : null;
        const needsConnection = authorIds.filter((id) => tiers.get(id) === TIERS.NETWORK && id !== viewer);
        const regularAuthors = authorIds.filter((id) => !business.has(id));
        const regularPostIds = context === 'discovery'
            ? commercial.filter((p) => regularAuthors.includes(idOf(p))).map((p) => p._id)
            : [];
        const [connected, listed] = await Promise.all([
            connectionsOf(viewer, needsConnection),
            activeListingPostIds(regularPostIds),
        ]);

        const visible = posts.filter((p) => {
            if (!COMMERCIAL_TYPES.has(p.contentType)) return true;
            const author = idOf(p);
            if (!author) return false;
            const isOwner = author === viewer;
            if (business.has(author)) {
                return canSeeCommercial(tiers.get(author), { isOwner, isConnected: connected.has(author) });
            }
            // Regular user: discovery needs an active paid listing (#80).
            if (context === 'discovery' && !isOwner) return listed.has(String(p._id));
            return true;
        });
        if (keepOrder) return visible;
        return premiumFirst(visible, (p) => COMMERCIAL_TYPES.has(p.contentType) && tiers.get(idOf(p)) === TIERS.PREMIUM);
    } catch (error) {
        console.error('[visibility] filter failed, showing unfiltered:', error?.message);
        return posts;
    }
};

/** Can this viewer open this one post? (post detail) */
export const canViewCommercialPost = async (post, viewerId) => {
    if (!post || !COMMERCIAL_TYPES.has(post.contentType)) return true;
    const out = await filterCommercialPosts([post], viewerId, { context: 'feed', keepOrder: true });
    return out.length === 1;
};

/** Recomputes and stores a business's tier (search index, admin panel). */
export const refreshStoredTier = async (userId) => {
    const { tiers } = await tiersFor([userId]);
    const tier = tiers.get(String(userId));
    if (tier) await Business.updateOne({ userId }, { $set: { visibilityTier: tier } });
    return tier;
};
