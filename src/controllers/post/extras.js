import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { User } from '../../models/user.models.js';
import Block from '../../models/block.models.js';
import { resolveMentions, notifyMentions } from '../../utils/mentions.utils.js';
import { notifyActivity } from '../../utils/activityNotify.utils.js';
import { applyMediaLayout, normalizeCollaboratorIds, normalizeSubcategories } from '../../utils/postExtras.utils.js';
import { finishDraft } from '../draft.controllers.js';

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Who may be invited to collaborate: an active account that hasn't blocked
 * the owner (or been blocked by them). Collabs are public by nature, so the
 * owner's own account must be public.
 */
export const vetCollaborators = async (ownerId, ids) => {
    if (!ids.length) return [];
    const owner = await User.findById(ownerId).select('privacy isFullPrivate').lean();
    if (owner?.privacy === 'private' || owner?.isFullPrivate) {
        throw new ApiError(400, 'Collab posts need a public account. Make your account public to invite a collaborator.');
    }
    const [users, blocks] = await Promise.all([
        User.find({ _id: { $in: ids }, isDeleted: { $ne: true }, accountStatus: 'active' }).select('_id').lean(),
        Block.find({
            $or: [
                { blockerId: ownerId, blockedId: { $in: ids } },
                { blockedId: ownerId, blockerId: { $in: ids } },
            ],
        }).select('blockerId blockedId').lean(),
    ]);
    const blocked = new Set(blocks.flatMap((b) => [String(b.blockerId), String(b.blockedId)]));
    return users.map((u) => String(u._id)).filter((id) => !blocked.has(id));
};

export const sendCollabInvites = (post, ownerId, ids) => Promise.allSettled(ids.map((recipientId) => notifyActivity({
    recipientId,
    senderId: ownerId,
    type: 'collab_invite',
    message: 'invited you to collaborate on a post',
    postId: post._id,
    push: { title: 'Collab invite', url: '/notifications' },
})));

/**
 * The Phase 2 fields of a new post, computed before it is written, plus what
 * to do once it exists (notifications).
 *
 *   const extras = await buildPostExtras(body, userId, { explicitMentions, isVibe });
 *   Post.create({ ..., ...extras.fields, media: extras.decorateMedia(uploaded) })
 *   extras.after(post)
 */
export const buildPostExtras = async (body = {}, userId, { explicitMentions = [], isVibe = false } = {}) => {
    const mentions = await resolveMentions({
        texts: [body.caption, body.description],
        explicitIds: explicitMentions || [],
        authorId: userId,
    });
    const subcategories = normalizeSubcategories(body.subcategories);
    const collaboratorIds = await vetCollaborators(
        userId,
        normalizeCollaboratorIds(body.collaborators ?? body.collaboratorIds, userId, isValidId),
    );

    const fields = { mentions };
    if (subcategories !== undefined) fields.subcategories = subcategories;
    if (collaboratorIds.length) {
        fields.collaborators = collaboratorIds.map((id) => ({ userId: id, status: 'pending', invitedAt: new Date() }));
    }

    return {
        fields,
        decorateMedia: (media) => applyMediaLayout(media, body.mediaLayout, { isVibe }),
        after: async (post) => {
            if (!post || post.status === 'draft') return;
            await Promise.allSettled([
                finishDraft(body.draftId, userId, post),
                notifyMentions({ mentionIds: mentions, authorId: userId, postId: post._id }),
                sendCollabInvites(post, userId, collaboratorIds),
            ]);
        },
    };
};
