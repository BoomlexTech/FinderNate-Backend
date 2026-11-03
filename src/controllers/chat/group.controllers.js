import mongoose from 'mongoose';
import Chat from '../../models/chat.models.js';
import { User } from '../../models/user.models.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { safeEmitToChat, safeEmitToUser, getBlockedParticipantIds } from './helpers.js';
import {
    ROLES,
    MAX_GROUP_MEMBERS,
    roleOf,
    effectiveOwnerId,
    checkGroupPermission,
    joinedAtOf,
    bySeniority,
    parseDisappearingSeconds,
    nextOwnerAfterLeave,
} from '../../utils/chatRoles.rules.js';
import { postSystemMessage, invalidateChatLists } from '../../utils/chatSystem.utils.js';

const PUBLIC_USER = 'username fullName profileImageUrl';

const loadMemberChat = async (chatId, userId) => {
    if (!mongoose.Types.ObjectId.isValid(chatId)) throw new ApiError(400, 'Invalid chat id');
    const chat = await Chat.findOne({ _id: chatId, participants: userId });
    if (!chat) throw new ApiError(404, 'Chat not found or you are not a participant');
    return chat;
};

const assertAllowed = (chat, actorId, action, targetId) => {
    const why = checkGroupPermission(chat, actorId, action, targetId);
    if (why) throw new ApiError(403, why);
};

const actorOf = (req) => ({ _id: req.user._id, username: req.user.username, fullName: req.user.fullName });

/** Stamps ownerId on groups that predate it, so the role is stored, not just derived. */
const settleOwner = (chat) => {
    const owner = effectiveOwnerId(chat);
    if (owner && String(chat.ownerId || '') !== owner) chat.ownerId = owner;
    return owner;
};

/** One member list entry per participant, with their role. */
const memberList = async (chat, viewerId) => {
    const users = await User.find({ _id: { $in: chat.participants } }).select(PUBLIC_USER).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const ordered = bySeniority(chat, chat.participants.map(String));
    const rank = { owner: 0, admin: 1, member: 2 };
    const members = ordered
        .map((id) => ({
            user: byId.get(id) || { _id: id, username: 'deleted', fullName: 'Deleted account' },
            role: roleOf(chat, id),
            joinedAt: joinedAtOf(chat, id),
            isYou: id === String(viewerId),
        }))
        .sort((a, b) => rank[a.role] - rank[b.role]);
    return members;
};

/** GET /chats/:chatId/members */
export const getGroupMembers = asyncHandler(async (req, res) => {
    const chat = await loadMemberChat(req.params.chatId, req.user._id);
    if (chat.chatType !== 'group') throw new ApiError(400, 'Only group chats have a member list');

    const myRole = roleOf(chat, req.user._id);
    const members = await memberList(chat, req.user._id);

    // Blocked list is for the people who can unblock.
    let blocked = [];
    if (myRole === ROLES.OWNER || myRole === ROLES.ADMIN) {
        blocked = await User.find({ _id: { $in: chat.blockedUsers || [] } }).select(PUBLIC_USER).lean();
    }

    return res.status(200).json(new ApiResponse(200, {
        chatId: chat._id,
        ownerId: effectiveOwnerId(chat),
        myRole,
        members,
        blocked,
        maxMembers: MAX_GROUP_MEMBERS,
        permissions: {
            canAddMembers: !checkGroupPermission(chat, req.user._id, 'add_members'),
            canEditInfo: !checkGroupPermission(chat, req.user._id, 'edit_info'),
            canManageAdmins: myRole === ROLES.OWNER,
            canDeleteGroup: myRole === ROLES.OWNER,
        },
    }, 'Group members fetched'));
});

/** POST /chats/:chatId/members  { userIds: [] } */
export const addGroupMembers = asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    assertAllowed(chat, actorId, 'add_members');

    const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId].filter(Boolean);
    const requested = [...new Set(raw.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!requested.length) throw new ApiError(400, 'userIds is required');

    const current = new Set(chat.participants.map(String));
    const banned = new Set((chat.blockedUsers || []).map(String));
    const candidates = requested.filter((id) => !current.has(id));

    const users = await User.find({
        _id: { $in: candidates },
        isDeleted: { $ne: true },
        accountStatus: { $in: ['active', null] },
    }).select('_id').lean();
    const existing = new Set(users.map((u) => String(u._id)));
    const blockedPairs = await getBlockedParticipantIds(actorId, candidates);

    const skipped = [];
    const toAdd = [];
    for (const id of requested) {
        if (current.has(id)) skipped.push({ userId: id, reason: 'already_member' });
        else if (!existing.has(id)) skipped.push({ userId: id, reason: 'not_found' });
        else if (banned.has(id)) skipped.push({ userId: id, reason: 'blocked_in_group' });
        else if (blockedPairs.has(id)) skipped.push({ userId: id, reason: 'blocked' });
        else toAdd.push(id);
    }

    if (chat.participants.length + toAdd.length > MAX_GROUP_MEMBERS) {
        throw new ApiError(400, `Groups can have up to ${MAX_GROUP_MEMBERS} members`);
    }

    if (toAdd.length) {
        settleOwner(chat);
        const now = new Date();
        chat.participants.push(...toAdd.map((id) => new mongoose.Types.ObjectId(id)));
        chat.memberSince = chat.memberSince || [];
        for (const id of toAdd) chat.memberSince.push({ userId: id, joinedAt: now, addedBy: actorId });
        await chat.save();

        await postSystemMessage(chat, 'members_added', { actorId, targetIds: toAdd });
        safeEmitToChat(chat._id, 'group_members_added', { chatId: chat._id, userIds: toAdd, addedBy: actorOf(req) });
        toAdd.forEach((id) => safeEmitToUser(id, 'added_to_group', { chatId: chat._id, groupName: chat.groupName, addedBy: actorOf(req) }));
        invalidateChatLists(chat.participants);
    }

    return res.status(200).json(new ApiResponse(200, {
        added: toAdd,
        skipped,
        members: await memberList(chat, actorId),
    }, toAdd.length ? 'Members added' : 'Nobody new to add'));
});

/** Shared by remove and block. */
const removeFromGroup = async (req, res, { block }) => {
    const actorId = req.user._id;
    const { memberId } = req.params;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    assertAllowed(chat, actorId, block ? 'block_member' : 'remove_member', memberId);

    settleOwner(chat);
    const wasMember = chat.participants.some((p) => String(p) === String(memberId));
    chat.participants = chat.participants.filter((p) => String(p) !== String(memberId));
    chat.admins = (chat.admins || []).filter((a) => String(a) !== String(memberId));
    chat.memberSince = (chat.memberSince || []).filter((m) => String(m.userId) !== String(memberId));
    if (block && !(chat.blockedUsers || []).some((b) => String(b) === String(memberId))) {
        chat.blockedUsers = [...(chat.blockedUsers || []), memberId];
    }
    chat.stats = chat.stats || {};
    chat.stats.totalParticipants = chat.participants.length;
    await chat.save();

    await postSystemMessage(chat, block ? 'member_blocked' : 'member_removed', { actorId, targetIds: [memberId] });

    const removedBy = actorOf(req);
    safeEmitToChat(chat._id, 'group_member_removed', { chatId: chat._id, memberId, removedBy, blocked: !!block });
    if (wasMember) safeEmitToUser(memberId, 'removed_from_group', { chatId: chat._id, groupName: chat.groupName, removedBy, blocked: !!block });
    invalidateChatLists([...chat.participants, memberId]);

    const populatedChat = await Chat.findById(chat._id)
        .populate('participants', PUBLIC_USER)
        .populate('createdBy', PUBLIC_USER);
    return res.status(200).json(new ApiResponse(200, populatedChat, block ? 'Removed and blocked' : 'Member removed successfully'));
};

/** DELETE /chats/:chatId/members/:memberId  (?block=true also blocks) */
export const removeGroupMember = asyncHandler(async (req, res) =>
    removeFromGroup(req, res, { block: req.query?.block === 'true' || req.body?.block === true }));

/** POST /chats/:chatId/blocked/:memberId */
export const blockGroupMember = asyncHandler(async (req, res) => removeFromGroup(req, res, { block: true }));

/** DELETE /chats/:chatId/blocked/:memberId */
export const unblockGroupMember = asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const { memberId } = req.params;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    assertAllowed(chat, actorId, 'unblock_member', memberId);

    const before = (chat.blockedUsers || []).length;
    chat.blockedUsers = (chat.blockedUsers || []).filter((b) => String(b) !== String(memberId));
    if (chat.blockedUsers.length !== before) {
        await chat.save();
        await postSystemMessage(chat, 'member_unblocked', { actorId, targetIds: [memberId] });
    }
    return res.status(200).json(new ApiResponse(200, { chatId: chat._id, memberId }, 'Unblocked. They can be added again.'));
});

/** POST /chats/:chatId/admins/:memberId and DELETE (owner only) */
const setAdmin = (makeAdmin) => asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const { memberId } = req.params;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    assertAllowed(chat, actorId, makeAdmin ? 'make_admin' : 'remove_admin', memberId);

    settleOwner(chat);
    chat.admins = makeAdmin
        ? [...(chat.admins || []), memberId]
        : (chat.admins || []).filter((a) => String(a) !== String(memberId));
    await chat.save();

    await postSystemMessage(chat, makeAdmin ? 'admin_added' : 'admin_removed', { actorId, targetIds: [memberId] });
    safeEmitToChat(chat._id, 'group_roles_updated', { chatId: chat._id, ownerId: effectiveOwnerId(chat), admins: chat.admins });

    return res.status(200).json(new ApiResponse(200, {
        chatId: chat._id,
        ownerId: effectiveOwnerId(chat),
        admins: chat.admins,
    }, makeAdmin ? 'Now an admin' : 'No longer an admin'));
});

export const makeGroupAdmin = setAdmin(true);
export const removeGroupAdmin = setAdmin(false);

/** POST /chats/:chatId/owner  { userId } */
export const transferGroupOwnership = asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const targetId = String(req.body?.userId || '');
    const chat = await loadMemberChat(req.params.chatId, actorId);
    assertAllowed(chat, actorId, 'transfer_owner', targetId);

    chat.ownerId = targetId;
    // The old owner stays on as an admin, as in WhatsApp.
    const admins = new Set((chat.admins || []).map(String));
    admins.add(String(actorId));
    admins.delete(targetId);
    chat.admins = [...admins];
    await chat.save();

    await postSystemMessage(chat, 'owner_changed', { actorId, targetIds: [targetId] });
    safeEmitToChat(chat._id, 'group_roles_updated', { chatId: chat._id, ownerId: targetId, admins: chat.admins });

    return res.status(200).json(new ApiResponse(200, { chatId: chat._id, ownerId: targetId, admins: chat.admins }, 'Ownership transferred'));
});

/** POST /chats/:chatId/leave */
export const leaveGroup = asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    if (chat.chatType !== 'group') throw new ApiError(400, 'Only group chats can be left');

    const wasOwner = roleOf(chat, actorId) === ROLES.OWNER;
    // Work out the successor before removing the leaver.
    const successor = wasOwner ? nextOwnerAfterLeave(chat, actorId) : null;

    chat.participants = chat.participants.filter((p) => String(p) !== String(actorId));
    chat.admins = (chat.admins || []).filter((a) => String(a) !== String(actorId));
    chat.memberSince = (chat.memberSince || []).filter((m) => String(m.userId) !== String(actorId));
    if (wasOwner) chat.ownerId = successor || undefined;
    else settleOwner(chat);
    chat.stats = chat.stats || {};
    chat.stats.totalParticipants = chat.participants.length;
    await chat.save();

    if (chat.participants.length) {
        await postSystemMessage(chat, 'member_left', { actorId });
        if (wasOwner && successor) {
            await postSystemMessage(chat, 'owner_changed', { actorId, targetIds: [successor], data: { reason: 'left' } });
        }
    }

    safeEmitToChat(chat._id, 'group_member_left', {
        chatId: chat._id,
        leftBy: actorOf(req),
        newOwnerId: wasOwner ? successor : null,
        // Older clients read this name.
        promotedAdminId: wasOwner ? successor : null,
    });
    invalidateChatLists([...chat.participants, actorId]);

    return res.status(200).json(new ApiResponse(200, {
        chatId: chat._id,
        newOwnerId: wasOwner ? successor : null,
        promotedAdminId: wasOwner ? successor : null,
    }, 'You have left the group'));
});

/**
 * PATCH /chats/:chatId/disappearing  { seconds: 0 | 86400 | 604800 | 7776000 }
 * (or 'off' | '24h' | '7d' | '90d'). Direct chats: either person. Groups:
 * owner and admins. Applies to messages sent from now on.
 */
export const setDisappearingMessages = asyncHandler(async (req, res) => {
    const actorId = req.user._id;
    const chat = await loadMemberChat(req.params.chatId, actorId);
    const seconds = parseDisappearingSeconds(req.body?.seconds ?? req.body?.duration);
    if (seconds === null) throw new ApiError(400, 'seconds must be 0, 86400 (24 hours), 604800 (7 days) or 7776000 (90 days)');
    if (chat.chatType === 'group') assertAllowed(chat, actorId, 'set_timer');

    const previous = Number(chat.disappearing?.seconds) || 0;
    if (previous !== seconds) {
        chat.disappearing = { seconds, updatedBy: actorId, updatedAt: new Date() };
        await chat.save();
        await postSystemMessage(chat, seconds ? 'disappearing_on' : 'disappearing_off', { actorId, data: { seconds } });
        safeEmitToChat(chat._id, 'chat_disappearing_updated', { chatId: chat._id, seconds, updatedBy: actorOf(req) });
    }

    return res.status(200).json(new ApiResponse(200, { chatId: chat._id, seconds }, seconds ? 'Disappearing messages on' : 'Disappearing messages off'));
});
