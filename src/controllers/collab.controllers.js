import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import Post from '../models/userPost.models.js';
import { User } from '../models/user.models.js';
import { vetCollaborators, sendCollabInvites } from './post/extras.js';
import { notifyActivity } from '../utils/activityNotify.utils.js';
import { invalidatePostCaches } from './post/helpers.js';
import { MAX_COLLABORATORS } from '../utils/postExtras.utils.js';
import { attachCollaborators } from '../utils/collab.utils.js';

/**
 * Collab posts (Phase 2 #50 photo, #57 video). The owner invites up to three
 * people; each accepts or declines. An accepted collab shows on both
 * profiles, says "A and B" in the header, and shares one set of likes and
 * comments because it is one post. Either side can end it.
 */

const loadPost = async (postId) => {
    if (!mongoose.Types.ObjectId.isValid(String(postId))) throw new ApiError(404, 'Post not found');
    const post = await Post.findById(postId).select('userId collaborators postType status').lean();
    if (!post) throw new ApiError(404, 'Post not found');
    return post;
};

const entryFor = (post, userId) => (post.collaborators || []).find((c) => String(c.userId) === String(userId));

/** Count toward the limit: pending and accepted invites. Pure. */
export const activeCollaboratorCount = (collaborators = []) =>
    collaborators.filter((c) => c.status === 'pending' || c.status === 'accepted').length;

/** POST /posts/:postId/collaborators { userId } — owner invites. */
export const inviteCollaborator = asyncHandler(async (req, res) => {
    const ownerId = req.user._id;
    const post = await loadPost(req.params.postId);
    if (String(post.userId) !== String(ownerId)) throw new ApiError(403, 'Only the creator can invite collaborators');
    const { userId } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(userId)) || String(userId) === String(ownerId)) {
        throw new ApiError(400, 'Choose someone to invite');
    }
    const existing = entryFor(post, userId);
    if (existing && existing.status !== 'declined') {
        throw new ApiError(409, existing.status === 'accepted' ? 'They are already a collaborator' : 'They already have an invite');
    }
    if (activeCollaboratorCount(post.collaborators) >= MAX_COLLABORATORS) {
        throw new ApiError(400, `A post can have up to ${MAX_COLLABORATORS} collaborators`);
    }
    const [allowed] = await vetCollaborators(ownerId, [String(userId)]);
    if (!allowed) throw new ApiError(400, "You can't invite this account");

    await Post.updateOne({ _id: post._id }, { $pull: { collaborators: { userId: allowed } } });
    await Post.updateOne({ _id: post._id }, {
        $push: { collaborators: { userId: allowed, status: 'pending', invitedAt: new Date(), respondedAt: null } },
    });
    await sendCollabInvites(post, ownerId, [allowed]);
    return res.status(200).json(new ApiResponse(200, { postId: post._id, userId: allowed, status: 'pending' }, 'Invite sent'));
});

const respond = (status) => asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const post = await loadPost(req.params.postId);
    const entry = entryFor(post, userId);
    if (!entry || entry.status !== 'pending') throw new ApiError(404, 'There is no invite to answer');
    await Post.updateOne(
        { _id: post._id, collaborators: { $elemMatch: { userId, status: 'pending' } } },
        { $set: { 'collaborators.$.status': status, 'collaborators.$.respondedAt': new Date() } },
    );
    if (status === 'accepted') {
        notifyActivity({
            recipientId: post.userId,
            senderId: userId,
            type: 'collab_accepted',
            message: 'accepted your collab invite',
            postId: post._id,
            push: { title: 'Collab accepted' },
        }).catch(() => {});
        await invalidatePostCaches(post._id, userId);
    }
    return res.status(200).json(new ApiResponse(200, { postId: post._id, status }, status === 'accepted' ? 'You are now a collaborator' : 'Invite declined'));
});

/** POST /posts/:postId/collab/accept */
export const acceptCollab = respond('accepted');
/** POST /posts/:postId/collab/decline */
export const declineCollab = respond('declined');

/**
 * DELETE /posts/:postId/collaborators/:userId — the owner removes anyone;
 * a collaborator removes themselves (leaves the collab).
 */
export const removeCollaborator = asyncHandler(async (req, res) => {
    const actorId = String(req.user._id);
    const post = await loadPost(req.params.postId);
    const targetId = String(req.params.userId);
    const isOwner = String(post.userId) === actorId;
    if (!isOwner && targetId !== actorId) throw new ApiError(403, 'You can only remove yourself');
    if (!entryFor(post, targetId)) throw new ApiError(404, 'Not a collaborator on this post');
    await Post.updateOne({ _id: post._id }, { $pull: { collaborators: { userId: targetId } } });
    await invalidatePostCaches(post._id, post.userId);
    return res.status(200).json(new ApiResponse(200, { postId: post._id, userId: targetId }, isOwner ? 'Collaborator removed' : 'You left the collab'));
});

/** GET /posts/collab/invites — invites waiting for the caller. */
export const listCollabInvites = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const posts = await Post.find({ collaborators: { $elemMatch: { userId, status: 'pending' } } })
        .sort({ createdAt: -1 }).limit(50)
        .select('userId postType contentType caption description media createdAt collaborators')
        .populate('userId', 'username fullName profileImageUrl')
        .lean();
    for (const p of posts) p.media = (p.media || []).slice(0, 1);
    await attachCollaborators(posts, userId);
    return res.status(200).json(new ApiResponse(200, { invites: posts }, 'Collab invites fetched'));
});

/** Used by the user search in the invite sheet: a light lookup by username. */
export const lookupCollaborator = async (username) => User.findOne({ username: String(username || '').toLowerCase() })
    .select('_id username fullName profileImageUrl').lean();
