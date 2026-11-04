import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { User } from '../../models/user.models.js';
import Block from '../../models/block.models.js';
import { resolveMentions, notifyMentions } from '../../utils/mentions.utils.js';
import { notifyActivity } from '../../utils/activityNotify.utils.js';
import { applyMediaLayout, normalizeCollaboratorIds, normalizeSubcategories } from '../../utils/postExtras.utils.js';
import { finishDraft } from '../draft.controllers.js';
import { loadFinishedEdit, markEditUsed } from '../edits.controllers.js';
import Sound from '../../models/sound.models.js';
import { loadUsableSound, musicFieldFrom, bumpSoundUsage } from '../../services/sounds.service.js';
import { enqueueOriginalAudio } from '../../queues/creatorQueue.js';
import { sanitizeMusicChoice, fitMusicWindow, parseJsonField, MUSIC_MAX_SECONDS } from '../../utils/phase5.rules.js';

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

    // Phase 5: a video that went through the editor (#29, #34, #49) and music on photos (#29).
    const edit = await loadFinishedEdit(body.editId, userId);
    const fields = { mentions };
    let chosenSoundId = null;
    if (edit?.duet?.postId) {
        fields.duet = { postId: edit.duet.postId, authorId: edit.duet.authorId, authorUsername: edit.duet.authorUsername, layout: edit.duet.layout };
    }
    if (edit?.music?.soundId) {
        const sound = await Sound.findById(edit.music.soundId).lean();
        if (sound) { fields.music = musicFieldFrom(sound, edit.music, { mixed: true }); chosenSoundId = sound._id; }
    } else if (body.music) {
        if (edit || isVibe || ['reel', 'video'].includes(body.postType)) {
            throw new ApiError(400, 'To add music to a video, use the video editor first.');
        }
        const choice = sanitizeMusicChoice(parseJsonField(body.music, null), { max: MUSIC_MAX_SECONDS.post });
        if (choice) {
            const sound = await loadUsableSound(choice.soundId, userId);
            fields.music = musicFieldFrom(sound, fitMusicWindow(choice, sound.durationSec), { mixed: false });
            chosenSoundId = sound._id;
        }
    }
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
                chosenSoundId ? bumpSoundUsage(chosenSoundId) : null,
                edit ? markEditUsed(edit._id, { postId: post._id }) : null,
                post.duet?.authorId ? notifyActivity({
                    recipientId: post.duet.authorId,
                    senderId: userId,
                    type: 'duet',
                    message: 'made a duet with your video',
                    postId: post._id,
                    push: { title: 'New duet', url: '/notifications' },
                }) : null,
                // The sound of a new vibe becomes "Original audio" others can reuse.
                (post.status === 'published' && ['reel', 'video'].includes(post.postType) && !post.music?.soundId && !post.duet?.postId)
                    ? enqueueOriginalAudio(post._id) : null,
            ]);
        },
    };
};
