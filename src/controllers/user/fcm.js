import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import UserDevice from "../../models/userDevice.models.js";

const saveFCMToken = asyncHandler(async (req, res) => {
    const { fcmToken } = req.body;
    const userId = req.user?._id;

    // Normalise FIRST, and treat anything that is not a non-empty string as absent.
    // The updateMany below filters BY this value, so a blank/whitespace/non-string value
    // reaching it would be catastrophic (see the guard comment there). The original
    // `if (!fcmToken)` check already rejected undefined/null/"" but would have let a
    // whitespace-only string (" ") or a non-string body value through to the query.
    const deviceToken = typeof fcmToken === "string" ? fcmToken.trim() : "";

    if (!deviceToken) {
        throw new ApiError(400, "FCM token is required");
    }

    if (!userId) {
        return res.status(200).json(
            new ApiResponse(200, {
                saved: false,
                reason: "not_authenticated"
            }, "User not authenticated. FCM token will be saved after login.")
        );
    }

    // Detach this device token from every OTHER account before claiming it for the current one.
    // An FCM token identifies a PHYSICAL DEVICE, not an account, so two accounts must never hold
    // the same one at the same time — the loser of that race receives the winner's pushes.
    //
    // This, not logout, is what actually closes the collision in the common case: it does not
    // depend on the previous session having ended cleanly. A crash, a force-quit, or an access
    // token that simply expired all leave the old account still holding this device's token with
    // no logout ever running. This call site is the ONLY point where we definitively know the
    // device now belongs to someone else, because someone else just authenticated on it.
    //
    // The `deviceToken &&` guard is load-bearing, not defensive noise: the filter matches BY token
    // value, so if the value were ever empty or null the filter would degenerate to
    // "every user whose fcmToken is null" and null out the token of every such account in the DB.
    // `deviceToken` is already proven to be a non-empty trimmed string above; this re-asserts it
    // at the dangerous call site so no future edit to the guard above can quietly re-open it.
    if (deviceToken) {
        await User.updateMany(
            { _id: { $ne: userId }, fcmToken: deviceToken },
            { $set: { fcmToken: null, fcmTokenUpdatedAt: new Date() } }
        );
        // This older endpoint means one account per device, so the device
        // register (Phase 3 #25) must agree. Newer apps use POST /users/me/devices.
        await UserDevice.deleteMany({ token: deviceToken, userId: { $ne: userId } });
        await UserDevice.updateOne(
            { userId, token: deviceToken },
            { $set: { lastSeenAt: new Date() }, $setOnInsert: { platform: 'other' } },
            { upsert: true }
        );
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { fcmToken: deviceToken, fcmTokenUpdatedAt: new Date() },
        { new: true }
    ).select('fcmToken fcmTokenUpdatedAt');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res.status(200).json(
        new ApiResponse(200, {
            saved: true,
            fcmToken: user.fcmToken,
            updatedAt: user.fcmTokenUpdatedAt
        }, "FCM token saved successfully")
    );
});

const checkFirebaseStatus = asyncHandler(async (req, res) => {
    const status = {
        envVarsPresent: {
            FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
            FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
            FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY
        },
        envVarsValues: {
            FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'NOT SET',
            FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || 'NOT SET',
            FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ?
                `${process.env.FIREBASE_PRIVATE_KEY.substring(0, 50)}... (${process.env.FIREBASE_PRIVATE_KEY.length} chars)` :
                'NOT SET'
        }
    };

    return res.status(200).json(
        new ApiResponse(200, status, "Firebase configuration status")
    );
});

const testFCMNotification = asyncHandler(async (req, res) => {
    const userId = req.user?._id;

    if (!userId) {
        throw new ApiError(401, "User not authenticated");
    }

    const user = await User.findById(userId).select('fcmToken username fullName');

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.fcmToken) {
        throw new ApiError(400, "No FCM token found for this user. Please refresh the app.");
    }

    try {
        const { sendNotification } = await import('../../config/firebase-admin.config.js');

        const notification = {
            title: "Test Notification",
            body: "This is a test FCM notification from FinderNate backend"
        };

        const data = {
            type: 'test',
            timestamp: new Date().toISOString()
        };

        const result = await sendNotification(user.fcmToken, notification, data);

        if (result.success) {
            return res.status(200).json(
                new ApiResponse(200, {
                    success: true,
                    messageId: result.messageId,
                    fcmToken: user.fcmToken.substring(0, 20) + '...'
                }, "Test FCM notification sent successfully")
            );
        } else {
            console.error('❌ Test FCM failed:', result.error);
            return res.status(500).json(
                new ApiResponse(500, {
                    success: false,
                    error: result.error,
                    invalidToken: result.invalidToken
                }, "Failed to send test FCM notification")
            );
        }
    } catch (error) {
        console.error('❌ FCM test error:', error);
        throw new ApiError(500, `FCM test failed: ${error.message}`);
    }
});

export {
    saveFCMToken,
    checkFirebaseStatus,
    testFCMNotification,
};
