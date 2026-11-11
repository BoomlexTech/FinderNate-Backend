import { User } from "../../models/user.models.js";
import Business from "../../models/business.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { checkIfscOnSave } from "../../utils/ifsc.utils.js";

// The account number is never returned in full to the seller — only the admin
// payout view reads it raw, because that is the person who has to type it into
// a banking app. Guarded on length so a short/garbage value cannot be echoed
// back whole by slice(-4).
const maskAccountNumber = (value) => {
    const raw = (value || '').toString();
    return raw.length >= 4 ? '****' + raw.slice(-4) : raw;
};

// POST /api/v1/business/bank-details
export const addOrUpdateBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const {
        accountHolderName,
        bankName,
        accountNumber,
        ifscCode,
        accountType,
        upiId,
        branchName
    } = req.body;

    if (!accountHolderName || !bankName || !ifscCode || !accountType) {
        throw new ApiError(400, "Account holder name, bank name, IFSC code, and account type are required");
    }

    if (!['savings', 'current'].includes(accountType.toLowerCase())) {
        throw new ApiError(400, "Account type must be either 'savings' or 'current'");
    }

    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (!ifscRegex.test(ifscCode.toUpperCase())) {
        throw new ApiError(400, "Invalid IFSC code format");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile. Please create a business profile first.");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    // ── The account number is OPTIONAL on update, and required only the first
    // ── time ──────────────────────────────────────────────────────────────────
    // It is only ever returned masked ('****1234'), so both clients blank the
    // field when they open the edit form. While it was mandatory, changing any
    // other detail — a branch name, a UPI id — forced the seller to retype their
    // full account number from memory. One slipped digit silently replaced a
    // correct account number with a wrong one, and payouts are MANUAL: an admin
    // reads this number and transfers real money to it. Nothing downstream would
    // have caught it.
    //
    // So: send a new number to change it, omit it to keep the stored one. A
    // masked value echoed back from a GET is treated as "unchanged" rather than
    // written literally — otherwise a client that prefilled the form would
    // overwrite the real number with the mask.
    const existingAccountNumber = business.bankDetails?.accountNumber;
    const submittedAccountNumber = typeof accountNumber === 'string' ? accountNumber.trim() : '';
    const looksMasked = /^[*x•]{2,}/i.test(submittedAccountNumber);

    let finalAccountNumber;
    if (submittedAccountNumber && !looksMasked) {
        // Digits only, and a length real Indian bank accounts fall inside.
        // Catches a pasted IFSC, a phone number with spaces, a truncated entry.
        if (!/^\d{6,20}$/.test(submittedAccountNumber)) {
            throw new ApiError(400, "Account number must be 6 to 20 digits, with no spaces or letters");
        }
        finalAccountNumber = submittedAccountNumber;
    } else if (existingAccountNumber) {
        finalAccountNumber = existingAccountNumber;
    } else {
        throw new ApiError(400, "Account number is required");
    }

    // Is this a real branch code? Checked with Cashfree when the IFSC is new or
    // changed. A code that does not exist is refused here, because payouts are
    // manual and a wrong IFSC means the admin cannot pay the seller. If Cashfree
    // cannot answer (no credentials, no balance, down) the details save as before.
    const ifscCheck = await checkIfscOnSave({
        ifsc: ifscCode,
        previousIfsc: business.bankDetails?.ifscCode
    });
    if (ifscCheck.checked && !ifscCheck.valid) {
        throw new ApiError(400, ifscCheck.message || "This IFSC code is not valid");
    }

    let paymentQRCodeUrl = business.bankDetails?.paymentQRCode;
    if (req.file) {
        const { uploadBufferToBunny } = await import('../../utils/bunny.js');

        const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedImageTypes.includes(req.file.mimetype)) {
            throw new ApiError(400, "Payment QR code must be an image (JPEG, PNG, or WebP)");
        }

        const folder = 'payment-qr-codes';
        const fileExtension = req.file.originalname.split('.').pop();
        const fileName = `qr-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExtension}`;

        const uploadResult = await uploadBufferToBunny(req.file.buffer, folder, fileName);

        if (!uploadResult || !uploadResult.url) {
            throw new ApiError(500, "Failed to upload payment QR code to storage");
        }

        paymentQRCodeUrl = uploadResult.url;
    }

    business.bankDetails = {
        accountHolderName: accountHolderName.trim(),
        bankName: bankName.trim(),
        accountNumber: finalAccountNumber,
        ifscCode: ifscCode.toUpperCase(),
        accountType: accountType.toLowerCase(),
        upiId: upiId ? upiId.toLowerCase() : business.bankDetails?.upiId,
        // The seller's own branch name wins; the verified one fills it in when empty.
        branchName: branchName
            ? branchName.trim()
            : (business.bankDetails?.branchName || (ifscCheck.valid ? ifscCheck.branch : undefined)),
        paymentQRCode: paymentQRCodeUrl,
        isVerified: false,
        verifiedAt: null,
        verifiedBy: null,
        updatedAt: new Date()
    };

    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {
            bankDetails: {
                accountHolderName: business.bankDetails.accountHolderName || '',
                bankName: business.bankDetails.bankName || '',
                accountNumber: maskAccountNumber(business.bankDetails.accountNumber),
                ifscCode: business.bankDetails.ifscCode || '',
                accountType: business.bankDetails.accountType || '',
                upiId: business.bankDetails.upiId || '',
                branchName: business.bankDetails.branchName || '',
                paymentQRCode: business.bankDetails.paymentQRCode || null,
                isVerified: business.bankDetails.isVerified || false,
                updatedAt: business.bankDetails.updatedAt || null,
                // Lets the client say "leave blank to keep the saved number"
                // instead of silently demanding a retype.
                accountNumberOnFile: true
            }
        }, "Bank details updated successfully")
    );
});

// GET /api/v1/business/bank-details
export const getBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    if (!business.bankDetails || !business.bankDetails.accountNumber) {
        return res.status(200).json(
            new ApiResponse(200, {
                bankDetails: null,
                hasBankDetails: false
            }, "No bank details found")
        );
    }

    return res.status(200).json(
        new ApiResponse(200, {
            bankDetails: {
                accountHolderName: business.bankDetails.accountHolderName || '',
                bankName: business.bankDetails.bankName || '',
                accountNumber: maskAccountNumber(business.bankDetails.accountNumber),
                // The client shows the mask and treats the input as optional:
                // blank means "keep this one". Without this the seller had to
                // retype the full number to change anything else on the form.
                accountNumberOnFile: true,
                ifscCode: business.bankDetails.ifscCode || '',
                accountType: business.bankDetails.accountType || '',
                upiId: business.bankDetails.upiId || '',
                branchName: business.bankDetails.branchName || '',
                paymentQRCode: business.bankDetails.paymentQRCode || null,
                isVerified: business.bankDetails.isVerified || false,
                verifiedAt: business.bankDetails.verifiedAt || null,
                updatedAt: business.bankDetails.updatedAt || null
            },
            hasBankDetails: true
        }, "Bank details retrieved successfully")
    );
});

// DELETE /api/v1/business/bank-details
export const deleteBankDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found");
    }

    if (!user.businessProfileId) {
        throw new ApiError(400, "User does not have a business profile");
    }

    const business = await Business.findById(user.businessProfileId);
    if (!business) {
        throw new ApiError(404, "Business profile not found");
    }

    if (!business.bankDetails || !business.bankDetails.accountNumber) {
        throw new ApiError(400, "No bank details to delete");
    }

    // Payout is manual, and these are the instructions the admin reads at payout
    // time: adminEscrow.controllers.js looks up Business.bankDetails when the
    // release is actually performed, not when the order is placed. Removing them
    // while money is still held leaves the admin with nowhere to send it, and
    // the release still goes through and debits the escrow ledger.
    const { default: Order } = await import("../../models/order.models.js");
    const heldOrders = await Order.countDocuments({
        sellerId: userId,
        paymentStatus: { $in: ['held', 'paid'] }
    });
    if (heldOrders > 0) {
        throw new ApiError(
            409,
            `You have ${heldOrders} order(s) with payment still in escrow. Your bank details are needed to pay you out and cannot be removed until those payouts are settled.`
        );
    }

    business.bankDetails = undefined;
    await business.save();

    return res.status(200).json(
        new ApiResponse(200, {}, "Bank details deleted successfully")
    );
});
