import { User } from "../../models/user.models.js";
import { invalidateAuthCache } from "../../middlewares/auth.middleware.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { notifyStatusChange } from "./helpers.js";

// GET /api/v1/admin/users
export const getAllUsers = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { page = 1, limit = 20, search, accountStatus, isDeleted } = req.query;

    let filter = {};

    if (isDeleted === 'true') {
        filter.isDeleted = true;
    } else {
        filter.isDeleted = { $ne: true };
    }

    if (search) {
        filter.$or = [
            { username: { $regex: search, $options: 'i' } },
            { fullName: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } }
        ];
    }

    if (accountStatus && ['active', 'deactivated', 'banned'].includes(accountStatus)) {
        filter.accountStatus = accountStatus;
    }

    const users = await User.find(filter)
        .select('-password -refreshToken')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

    const totalUsers = await User.countDocuments(filter);

    return res.status(200).json(
        new ApiResponse(200, {
            users,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalUsers / limit),
                totalUsers,
                hasNext: page < Math.ceil(totalUsers / limit),
                hasPrev: page > 1
            }
        }, "Users fetched successfully")
    );
});

// PUT /api/v1/admin/users/:userId/status
export const updateUserStatus = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { userId } = req.params;
    const { accountStatus, isDeleted, reason } = req.body;

    if (accountStatus === undefined && isDeleted === undefined) {
        throw new ApiError(400, "Provide accountStatus or isDeleted");
    }

    if (accountStatus !== undefined && !['active', 'deactivated', 'banned'].includes(accountStatus)) {
        throw new ApiError(400, "Invalid accountStatus. Must be active, deactivated, or banned");
    }

    const updateFields = { adminActionReason: reason || null };

    if (accountStatus !== undefined) {
        updateFields.accountStatus = accountStatus;
    }

    if (isDeleted !== undefined) {
        updateFields.isDeleted = isDeleted;
        updateFields.deletedAt = isDeleted ? new Date() : null;
    }

    const user = await User.findByIdAndUpdate(
        userId,
        updateFields,
        { new: true }
    ).select('-password -refreshToken');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    await invalidateAuthCache(userId);

    const isDeactivated = accountStatus === 'banned' || accountStatus === 'deactivated' || isDeleted === true;
    if (isDeactivated) {
        const notifyStatus = isDeleted === true ? 'deleted' : accountStatus;
        await notifyStatusChange(userId.toString(), notifyStatus);
    }

    const actionDesc = [];
    if (accountStatus !== undefined) actionDesc.push(`status → ${accountStatus}`);
    if (isDeleted !== undefined) actionDesc.push(`isDeleted → ${isDeleted}`);

    await req.admin.logActivity(
        `user_status_changed`,
        'user',
        userId,
        `User ${actionDesc.join(', ')}. Reason: ${reason || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, user, `User updated: ${actionDesc.join(', ')}`)
    );
});

// PUT /api/v1/admin/users/:userId/blue-tick
export const verifyBlueTick = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { userId } = req.params;
    const { isBlueTickVerified, reason } = req.body;

    if (typeof isBlueTickVerified !== 'boolean') {
        throw new ApiError(400, "isBlueTickVerified must be a boolean value");
    }

    const user = await User.findById(userId).select('-password -refreshToken');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.isBusinessProfile) {
        throw new ApiError(400, "User must have a business profile to get blue tick verification");
    }

    user.isBlueTickVerified = isBlueTickVerified;
    // An admin's decision owns the tick from here on: it no longer comes and
    // goes with Findernate Plus (utils/plusBadge.js).
    user.blueTickFromPlus = false;
    await user.save();

    await req.admin.logActivity(
        `blue_tick_${isBlueTickVerified ? 'verified' : 'unverified'}`,
        'user',
        userId,
        `Blue tick verification ${isBlueTickVerified ? 'granted' : 'revoked'} for user: ${user.username}. Reason: ${reason || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, {
            userId: user._id,
            username: user.username,
            fullName: user.fullName,
            isBusinessProfile: user.isBusinessProfile,
            isBlueTickVerified: user.isBlueTickVerified
        }, `Blue tick verification ${isBlueTickVerified ? 'granted' : 'revoked'} successfully`)
    );
});

// DELETE /api/v1/admin/users/:userId
export const deleteUser = asyncHandler(async (req, res) => {
    if (!req.admin.permissions.manageUsers) {
        throw new ApiError(403, "Insufficient permissions to manage users");
    }

    const { userId } = req.params;
    const { reason } = req.body;

    const user = await User.findByIdAndUpdate(
        userId,
        { isDeleted: true, deletedAt: new Date(), adminActionReason: reason || null },
        { new: true }
    ).select('-password -refreshToken');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    await invalidateAuthCache(userId);
    await notifyStatusChange(userId.toString(), 'deleted');

    await req.admin.logActivity(
        'user_deleted',
        'user',
        userId,
        `Soft deleted user: ${user.username}. Reason: ${reason || 'none'}`
    );

    return res.status(200).json(
        new ApiResponse(200, { userId }, "User deleted successfully")
    );
});
