import crypto from "node:crypto";
import { Admin } from "../../models/admin.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { sendEmail } from "../../utils/sendEmail.js";

/**
 * Forgot password for the admin panel, super admin included.
 *
 * There was no way back into the panel once an admin password was forgotten:
 * the only route to a new password was a script run against the database.
 *
 *   POST /admin/forgot-password { email }
 *     Emails a link to /admin/reset-password, valid RESET_TTL_MS. Always
 *     answers the same way, so it cannot be used to find admin emails.
 *   POST /admin/reset-password { email, token, password }
 *     Sets the new password, ends every admin session for that account and
 *     clears its failed sign-in counter.
 *
 * Only the SHA-256 of the token is stored. Both routes are public and carry
 * adminPasswordResetRateLimit (per IP); a new link is also refused for
 * RESEND_GAP_MS after the last one (per account).
 */
export const RESET_TTL_MS = 30 * 60 * 1000;

/** Side effects the tests replace. Redis is loaded only when needed. */
export const resetDeps = {
    clearFailedLogins: async (adminId) => {
        const { redisClient } = await import("../../config/redis.config.js");
        await redisClient.del(`admin:login:fail:${adminId}`);
    },
};
export const RESEND_GAP_MS = 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

const GENERIC_SENT =
    "If that email belongs to an admin, a link to reset the password has been sent. It works for 30 minutes.";

export const hashResetToken = (token) =>
    crypto.createHash("sha256").update(String(token)).digest("hex");

/** Why a new password is not accepted, or null when it is fine. */
export const passwordProblem = (password) => {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password.length > 128) return "Use at most 128 characters.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return "Use letters and at least one number.";
    }
    return null;
};

const sameHash = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};

const frontendUrl = () => (process.env.FRONTEND_URL || "https://findernate.com").replace(/\/+$/, "");

export const resetLinkFor = (email, token) =>
    `${frontendUrl()}/admin/reset-password?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;

// POST /api/v1/admin/forgot-password
export const adminForgotPassword = asyncHandler(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        throw new ApiError(400, "Enter your admin email.");
    }

    const admin = await Admin.findOne({ email }).select("+passwordResetRequestedAt");
    const now = Date.now();
    const recentlySent = admin?.passwordResetRequestedAt
        && now - new Date(admin.passwordResetRequestedAt).getTime() < RESEND_GAP_MS;

    if (admin && admin.isActive && !recentlySent) {
        const token = crypto.randomBytes(32).toString("hex");
        admin.passwordResetTokenHash = hashResetToken(token);
        admin.passwordResetExpires = new Date(now + RESET_TTL_MS);
        admin.passwordResetRequestedAt = new Date(now);
        await admin.save({ validateBeforeSave: false });

        const link = resetLinkFor(email, token);
        const sent = await sendEmail({
            to: email,
            subject: "Reset your Findernate admin password",
            text:
                `Hello ${admin.fullName || "admin"},\n\n` +
                `Someone asked to reset the password of the Findernate admin account ${email}.\n` +
                `Open this link within 30 minutes to choose a new password:\n\n${link}\n\n` +
                `If it was not you, ignore this email: your password stays the same.\n`,
            html:
                `<p>Hello ${escapeHtml(admin.fullName || "admin")},</p>` +
                `<p>Someone asked to reset the password of the Findernate admin account <b>${escapeHtml(email)}</b>.</p>` +
                `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#eab308;color:#111;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>` +
                `<p style="color:#555">The link works for 30 minutes. If it was not you, ignore this email: your password stays the same.</p>`,
        }).catch((err) => ({ success: false, error: err?.message }));
        if (!sent?.success) {
            console.error(`[ADMIN RESET] could not email the reset link to ${email}:`, sent?.error);
        }
    }

    return res.status(200).json(new ApiResponse(200, { sent: true }, GENERIC_SENT));
});

// POST /api/v1/admin/reset-password
export const adminResetPassword = asyncHandler(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const token = String(req.body?.token || "").trim();
    const password = req.body?.password;

    const invalid = new ApiError(400, "This reset link is not valid any more. Ask for a new one.");
    if (!email || !/^[a-f0-9]{64}$/.test(token)) throw invalid;

    const problem = passwordProblem(password);
    if (problem) throw new ApiError(400, problem);

    const admin = await Admin.findOne({ email })
        .select("+passwordResetTokenHash +passwordResetExpires +refreshToken");
    if (!admin || !admin.isActive) throw invalid;
    if (!admin.passwordResetExpires || new Date(admin.passwordResetExpires).getTime() < Date.now()) throw invalid;
    if (!sameHash(admin.passwordResetTokenHash, hashResetToken(token))) throw invalid;

    admin.password = password; // hashed by the pre-save hook
    admin.passwordResetTokenHash = undefined;
    admin.passwordResetExpires = undefined;
    admin.refreshToken = undefined; // sign out everywhere
    await admin.save({ validateBeforeSave: false });

    try {
        await resetDeps.clearFailedLogins(admin._id);
    } catch { /* the counter expires on its own */ }

    return res.status(200).json(new ApiResponse(200, { reset: true }, "Password changed. Sign in with the new password."));
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
