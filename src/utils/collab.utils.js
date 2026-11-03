import { User } from '../models/user.models.js';

/**
 * Collab co-authors on post payloads (Phase 2 #50/#57).
 *
 * Replaces each post's stored `collaborators` with the ACCEPTED ones as small
 * user objects, so the clients can render "A and B". Pending and declined
 * invites never leave the server, except to the post owner, who gets
 * `pendingCollaborators` for the posts they own.
 */
export const acceptedCollaboratorIds = (post) => (post?.collaborators || [])
    .filter((c) => c && c.status === 'accepted' && c.userId)
    .map((c) => String(c.userId?._id ?? c.userId));

export const attachCollaborators = async (posts, viewerId = null) => {
    if (!Array.isArray(posts) || posts.length === 0) return posts;
    const wanted = new Set();
    for (const post of posts) {
        for (const c of post?.collaborators || []) {
            if (c?.userId && (c.status === 'accepted' || c.status === 'pending')) wanted.add(String(c.userId?._id ?? c.userId));
        }
    }
    let byId = new Map();
    if (wanted.size) {
        try {
            const users = await User.find({ _id: { $in: [...wanted] }, isDeleted: { $ne: true }, accountStatus: 'active' })
                .select('username fullName profileImageUrl').lean();
            byId = new Map(users.map((u) => [String(u._id), u]));
        } catch { /* show the post without co-authors rather than fail */ }
    }
    for (const post of posts) {
        if (!post) continue;
        const stored = Array.isArray(post.collaborators) ? post.collaborators : [];
        const ownerId = String(post.userId?._id ?? post.userId ?? '');
        post.collaborators = stored
            .filter((c) => c?.status === 'accepted')
            .map((c) => byId.get(String(c.userId?._id ?? c.userId)))
            .filter(Boolean);
        if (viewerId && String(viewerId) === ownerId) {
            post.pendingCollaborators = stored
                .filter((c) => c?.status === 'pending')
                .map((c) => byId.get(String(c.userId?._id ?? c.userId)))
                .filter(Boolean);
        }
    }
    return posts;
};

/** Posts on a profile: the user's own plus accepted collabs (#50). */
export const authorOrCollabFilter = (userId) => ({
    $or: [
        { userId },
        { collaborators: { $elemMatch: { userId, status: 'accepted' } } },
    ],
});
