import mongoose from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { User } from '../../models/user.models.js';
import UserDevice, { MAX_ACCOUNTS_PER_DEVICE } from '../../models/userDevice.models.js';

const PLATFORMS = ['android', 'ios', 'web', 'other'];

/**
 * POST /users/me/devices
 * { token, platform, installId?, appVersion?, accountIds?: [all accounts signed in on this device] }
 *
 * Registers a push token for the signed-in account without taking it away
 * from the other accounts on the same phone (Phase 3 #25). `accountIds` is the
 * list of accounts the app currently holds; the token is detached from any
 * other account, so someone who signed out (or whose app crashed before
 * signing out) stops getting this phone's notifications. Up to 5 accounts per
 * device; the least recently used one is dropped beyond that.
 */
export const registerDevice = asyncHandler(async (req, res) => {
    const userId = String(req.user._id);
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 4096) throw new ApiError(400, 'token is required');

    const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : 'other';
    const installId = typeof req.body?.installId === 'string' ? req.body.installId.slice(0, 100) : null;
    const appVersion = typeof req.body?.appVersion === 'string' ? req.body.appVersion.slice(0, 40) : null;

    const accountIds = Array.isArray(req.body?.accountIds)
        ? [...new Set(req.body.accountIds.map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)))]
        : null;
    const keep = new Set([userId, ...(accountIds || [])]);

    await UserDevice.updateOne(
        { userId, token },
        { $set: { platform, installId, appVersion, lastSeenAt: new Date() } },
        { upsert: true }
    );

    if (accountIds) {
        // Accounts no longer signed in on this device lose its token.
        const stale = await UserDevice.find({ token, userId: { $nin: [...keep] } }).select('userId').lean();
        if (stale.length) {
            const staleIds = stale.map((d) => d.userId);
            await UserDevice.deleteMany({ token, userId: { $in: staleIds } });
            await User.updateMany({ _id: { $in: staleIds }, fcmToken: token }, { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } });
        }
    }

    // Cap: 5 accounts per device.
    const holders = await UserDevice.find({ token }).sort({ lastSeenAt: -1 }).select('_id userId').lean();
    if (holders.length > MAX_ACCOUNTS_PER_DEVICE) {
        const drop = holders.slice(MAX_ACCOUNTS_PER_DEVICE);
        await UserDevice.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
    }

    // The old single-token field: keep it for older code paths, but never let
    // it hand this device's notifications to an account that isn't on it.
    if (platform !== 'web') {
        await User.updateOne({ _id: userId }, { $set: { fcmToken: token, fcmTokenUpdatedAt: new Date() } });
        if (!accountIds) {
            // An app that doesn't list its accounts gets the old behaviour.
            await User.updateMany({ _id: { $ne: userId }, fcmToken: token }, { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } });
        } else {
            await User.updateMany({ _id: { $nin: [...keep] }, fcmToken: token }, { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } });
        }
    }

    const accountsOnDevice = await UserDevice.countDocuments({ token });
    return res.status(200).json(new ApiResponse(200, {
        saved: true,
        accountsOnDevice,
        maxAccountsPerDevice: MAX_ACCOUNTS_PER_DEVICE,
    }, 'Device registered'));
});

/**
 * DELETE /users/me/devices  { token }
 * Stops this device getting the signed-in account's notifications (used when
 * one account is signed out on a phone that keeps others).
 */
export const unregisterDevice = asyncHandler(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim()
        : typeof req.query?.token === 'string' ? req.query.token.trim() : '';
    if (!token) throw new ApiError(400, 'token is required');
    await UserDevice.deleteOne({ userId: req.user._id, token });
    await User.updateOne({ _id: req.user._id, fcmToken: token }, { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } });
    return res.status(200).json(new ApiResponse(200, { removed: true }, 'Device removed'));
});

/** GET /users/me/devices — how many devices get this account's notifications. */
export const listDevices = asyncHandler(async (req, res) => {
    const devices = await UserDevice.find({ userId: req.user._id })
        .sort({ lastSeenAt: -1 })
        .select('platform appVersion lastSeenAt createdAt')
        .lean();
    return res.status(200).json(new ApiResponse(200, { devices }, 'OK'));
});
