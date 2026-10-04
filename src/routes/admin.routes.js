import { Router } from "express";
import {
    // Authentication
    adminLogin,
    adminLogout,

    // Aadhaar Verification
    getPendingAadhaarVerifications,
    verifyAadhaarCard,
    getAadhaarVerificationHistory,

    // Report Management
    getAllReports,
    updateReportStatus,
    deleteReport,

    // User Management
    getAllUsers,
    updateUserStatus,
    verifyBlueTick,
    deleteUser,

    // Business Management
    getAllBusinesses,
    getPendingBusinessVerifications,
    verifyBusinessAccount,
    getBusinessVerificationDetails,
    getBusinessVerificationHistory,
    verifyBusinessDocument,
    assignAccountManager,

    // Analytics & Dashboard
    getDashboardStats,
    getAdminActivityLog,

    // Super Admin Functions
    createAdmin,
    getAllAdmins,
    updateAdminPermissions
} from "../controllers/admin.controllers.js";

import {
    getEscrowDashboard,
    getEscrowTransactions,
    getAllOrders,
    getDisputedOrders,
    getRejectedOrders,
    resolveDispute,
    manualReleasePayment,
    manualRefundPayment,
    getOrderAnalytics,
    manualConfirmPayment,
    getSellerBankDetailsByOrder
} from "../controllers/adminEscrow.controllers.js";

import {
    getPaymentLogs,
    getSubscriptionLogs,
    getErrorLogs,
    getMetrics,
    testExpiryJob,
    getDashboard as getMonitoringDashboard
} from "../controllers/monitoring.controllers.js";

import {
    debugUserChats,
    cleanupProblematicChats
} from "../controllers/admin/chat.controllers.js";

import {
    addSetting,
    getSetting,
    getAllSettings,
    updateSetting
} from "../controllers/admin/settings.controllers.js";

import {
    verifyAdminJWT,
    requirePermission
} from "../middlewares/adminAuth.middleware.js";
import { adminLoginRateLimit } from "../middlewares/rateLimiter.middleware.js";
import {
    requireSuperAdmin,
    setAdminActiveStatus
} from "../controllers/admin/superadmin.controllers.js";

const router = Router();

// ===============================
// PUBLIC ROUTES (NO AUTH REQUIRED)
// ===============================
// The only unauthenticated route on this router, and the highest-value
// credential on the platform. It carried no limiter of its own, so the only
// thing in front of it was generalRateLimit's 50,000/minute — see
// adminLoginRateLimit for why this one fails closed. The per-ACCOUNT half of
// the throttle lives in controllers/admin/auth.controllers.js.
router.route("/login").post(adminLoginRateLimit, adminLogin);

// ===============================
// PROTECTED ROUTES (AUTH REQUIRED)
// ===============================
router.use(verifyAdminJWT); // Apply admin auth to all routes below

// Authentication
router.route("/logout").post(adminLogout);

// Dashboard & Analytics
router.route("/dashboard/stats").get(requirePermission('viewAnalytics'), getDashboardStats);
router.route("/activity-log").get(getAdminActivityLog);

// ===============================
// AADHAAR VERIFICATION ROUTES
// ===============================
router.route("/aadhaar-verification/pending").get(
    requirePermission('verifyAadhaar'),
    getPendingAadhaarVerifications
);

router.route("/aadhaar-verification/verify/:businessId").post(
    requirePermission('verifyAadhaar'),
    verifyAadhaarCard
);

router.route("/aadhaar-verification/history").get(
    requirePermission('verifyAadhaar'),
    getAadhaarVerificationHistory
);

// ===============================
// REPORT MANAGEMENT ROUTES
// ===============================
router.route("/reports").get(
    requirePermission('manageReports'),
    getAllReports
);

router.route("/reports/:reportId/status").put(
    requirePermission('manageReports'),
    updateReportStatus
);

router.route("/reports/:reportId").delete(
    requirePermission('manageReports'),
    deleteReport
);

// ===============================
// USER MANAGEMENT ROUTES
// ===============================
router.route("/users").get(
    requirePermission('manageUsers'),
    getAllUsers
);

router.route("/users/:userId/status").put(
    requirePermission('manageUsers'),
    updateUserStatus
);

router.route("/users/:userId").delete(
    requirePermission('manageUsers'),
    deleteUser
);

router.route("/users/:userId/blue-tick").put(
    requirePermission('manageUsers'),
    verifyBlueTick
);

// ===============================
// BUSINESS MANAGEMENT ROUTES
// ===============================
router.route("/businesses").get(
    requirePermission('manageBusiness'),
    getAllBusinesses
);

router.route("/businesses/pending-verification").get(
    requirePermission('manageBusiness'),
    getPendingBusinessVerifications
);

router.route("/businesses/:businessId/verify").post(
    requirePermission('manageBusiness'),
    verifyBusinessAccount
);

router.route("/businesses/:businessId/account-manager").put(
    requirePermission('manageBusiness'),
    assignAccountManager
);

router.route("/businesses/:businessId/details").get(
    requirePermission('manageBusiness'),
    getBusinessVerificationDetails
);

router.route("/businesses/verification-history").get(
    requirePermission('manageBusiness'),
    getBusinessVerificationHistory
);

router.route("/businesses/:businessId/documents/:documentId/verify").post(
    requirePermission('manageBusiness'),
    verifyBusinessDocument
);

// ===============================
// ADMIN MANAGEMENT ROUTES
// ===============================
// Creating admins and rewriting their permissions are super-admin only —
// these were the only routes under verifyAdminJWT with no gate at all, so any
// admin could grant itself every permission. The controllers repeat the check,
// so it holds however the handler is reached.
router.route("/create-admin").post(requireSuperAdmin, createAdmin);
router.route("/all-admins").get(getAllAdmins);
router.route("/:adminId/permissions").put(requireSuperAdmin, updateAdminPermissions);
// Offboarding an admin was a hand-edit of the admins collection — there was no
// delete route and no isActive route, so a departing or compromised staff
// account could not be switched off from inside the product. isActive is
// already enforced by verifyAdminJWT and adminLogin, so this also happens to be
// the only way to kill a token before it expires.
router.route("/:adminId/status").put(requireSuperAdmin, setAdminActiveStatus);

// ===============================
// ESCROW & ORDER MANAGEMENT ROUTES
// ===============================
// These eleven routes were the only money-touching routes on the router with no
// gate but the blanket verifyAdminJWT above, so a "reports only" moderator
// created with {manageReports:true} could still read a seller's account number
// and mark a payout released. Payouts here are a MANUAL bookkeeping record — the
// super admin reads the seller's bank details and transfers by hand — so the
// goal is gating WHICH admin reaches them, never hiding them from the account
// that does the transfers.
//
// The permission names are the eight the Admin schema already defines: reads go
// behind 'viewAnalytics', and the bank details plus everything that writes a
// payout/refund record go behind 'systemSettings', the existing high-trust flag.
// A dedicated 'manageEscrow' key would read better but cannot be introduced
// here — it would be absent from the schema and so evaluate false for every
// existing admin, locking the super admin out of the payout workflow.
router.route("/escrow/dashboard").get(requirePermission('viewAnalytics'), getEscrowDashboard);
router.route("/escrow/transactions").get(requirePermission('viewAnalytics'), getEscrowTransactions);
router.route("/escrow/orders").get(requirePermission('viewAnalytics'), getAllOrders);
router.route("/escrow/disputes").get(requirePermission('viewAnalytics'), getDisputedOrders);
router.route("/escrow/rejected").get(requirePermission('viewAnalytics'), getRejectedOrders);
router.route("/escrow/disputes/:orderId/resolve").post(requirePermission('systemSettings'), resolveDispute);
router.route("/escrow/orders/:orderId/release").post(requirePermission('systemSettings'), manualReleasePayment);
router.route("/escrow/orders/:orderId/refund").post(requirePermission('systemSettings'), manualRefundPayment);
router.route("/escrow/orders/:orderId/confirm").post(requirePermission('systemSettings'), manualConfirmPayment);
router.route("/escrow/orders/:orderId/seller-bank-details").get(requirePermission('systemSettings'), getSellerBankDetailsByOrder);
router.route("/escrow/analytics").get(requirePermission('viewAnalytics'), getOrderAnalytics);

// ===============================
// SETTINGS ROUTES (admin-only)
// ===============================
// GATEWAY_FEE and PLATFORM_FEE live here and feed the refund maths, so these
// four carry the 'systemSettings' permission the schema already defines rather
// than being open to every authenticated admin.
router.route("/settings")
    .post(requirePermission('systemSettings'), addSetting)
    .get(requirePermission('systemSettings'), getAllSettings);
router.route("/settings/:key")
    .get(requirePermission('systemSettings'), getSetting)
    .put(requirePermission('systemSettings'), updateSetting);

// ===============================
// MONITORING ROUTES
// ===============================
// These controllers document themselves as /api/v1/admin/monitoring/* and were
// imported here, but no admin route was ever registered for them — the only
// live registration was in subscription.routes.js, BELOW the ordinary
// `router.use(verifyJWT)`, so any signed-in user could read the platform
// payment log (every subscriber's id, plan, amount and Cashfree order id),
// internal error stack traces, whole-business revenue metrics, and could drive
// the expiry job on demand. Registered here instead, behind verifyAdminJWT.
// The expiry job is a state-changing sweep, so it takes the higher permission.
router.route("/monitoring/dashboard").get(requirePermission('viewAnalytics'), getMonitoringDashboard);
router.route("/monitoring/payment-logs").get(requirePermission('viewAnalytics'), getPaymentLogs);
router.route("/monitoring/subscription-logs").get(requirePermission('viewAnalytics'), getSubscriptionLogs);
router.route("/monitoring/error-logs").get(requirePermission('viewAnalytics'), getErrorLogs);
router.route("/monitoring/metrics").get(requirePermission('viewAnalytics'), getMetrics);
router.route("/monitoring/test-expiry-job").post(requirePermission('systemSettings'), testExpiryJob);

// ===============================
// CHAT MANAGEMENT ROUTES
// ===============================
router.route("/chats/debug").get(requirePermission('manageUsers'), debugUserChats);
router.route("/chats/cleanup").post(requirePermission('manageUsers'), cleanupProblematicChats);

export default router;
