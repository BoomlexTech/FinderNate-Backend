import { asyncHandler } from "../../utils/asyncHandler.js";
import UserDevice from "../../models/userDevice.models.js";
import { User } from "../../models/user.models.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { v4 as uuidv4 } from "uuid";
import { sendSms, assertSmsDeliverable } from "../../utils/sendSms.js";
import { TempUser } from "../../models/tempUser.models.js";
import { AuthOtp } from "../../models/authOtp.models.js";
import { AcceptanceLog } from "../../models/acceptanceLog.models.js";
import {
    SIGNUP_CONSENT_FIELD,
    readSignupConsent,
    buildSignupLegalAcceptance,
    getAllEffectiveVersions,
    extractClientMeta,
} from "../legal.controllers.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {
    generateAcessAndRefreshToken,
    OTP_EXPIRY_MS,
    RESEND_COOLDOWN_MS,
    resolveUserByIdentifier,
    assertValidPassword,
    assertMinimumAge,
    normalizePhone,
    rateCheckAndUpsertOtp,
    clientIp,
    assertOtpNotLocked,
    registerFailedOtpAttempt,
    assertLoginAttemptsAvailable,
    registerFailedLogin,
    clearFailedLogins,
} from "./_helpers.js";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const registerUser = asyncHandler(async (req, res) => {
    const { fullName, username, email, password, confirmPassword, phoneNumber, dateOfBirth, gender } = req.body;
    const request_type = 'phonenumber_verify';

    if (!fullName || !username || !email || !password || !confirmPassword || !phoneNumber) {
        throw new ApiError(400, "All fields are required");
    }

    if (password !== confirmPassword) {
        throw new ApiError(400, "Password and confirm password do not match");
    }

    //* Consent to the Terms of Use and Privacy Policy, from the checkbox on the
    //* signup form (SIGNUP_CONSENT_FIELD — see legal.controllers.js).
    //*
    //* THREE states, and the difference matters:
    //*   true  -> recorded against the account when the OTP is verified.
    //*   false -> the box was unticked. Refused, 400.
    //*   null  -> no flag in the body at all: an app or browser build that
    //*            predates the checkbox. Allowed through, because the shipped
    //*            app must keep being able to register; nothing is recorded as
    //*            accepted for it, exactly as before this existed.
    const signupConsent = readSignupConsent(req.body);

    if (signupConsent === false) {
        throw new ApiError(400, "You must accept the Terms of Use and Privacy Policy to create an account", [
            { field: SIGNUP_CONSENT_FIELD, message: "Please accept the Terms of Use and Privacy Policy to continue" }
        ]);
    }

    // Usernames become part of a public URL (/userprofile/<username>), so they
    // must be URL-safe. A username containing a space produced a %20 in the URL
    // which no longer matched the stored value, and the profile 404'd with
    // "Unable to load user profile". The model only does `trim`, which strips
    // outer whitespace but happily stores "megha bhat".
    // Validated here rather than on the schema on purpose: a schema-level
    // `match` also runs when SAVING pre-existing users, and a few legacy
    // accounts (e.g. "ravi@gmail.com") would then fail every future save.
    const normalizedUsername = String(username).trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername)) {
        throw new ApiError(400, "Username may only contain lowercase letters, numbers, dots, underscores and hyphens (3-30 characters), with no spaces", [
            { field: "username", message: "Username may only contain letters, numbers, dots, underscores and hyphens — no spaces" }
        ]);
    }

    //* Enforced here because neither write path validates: signup inserts via
    //* the raw driver and reset saves with validateBeforeSave:false, so the
    //* schema's minlength never ran and any length was accepted over the API.
    assertValidPassword(password);

    //* Age gate. Both clients only ever blocked a future date, and this handler
    //* wrote dateOfBirth straight through, so an 11-year-old could complete
    //* signup and get DMs from strangers and escrow checkout. Enforced here for
    //* the same reason as the password rule — the raw-driver insert below runs
    //* no schema validators, so nothing downstream would catch it.
    assertMinimumAge(dateOfBirth);

    const normalizedEmail = String(email).trim().toLowerCase();
    //* One canonical shape for phone numbers. The web sent countryCode+number
    //* and the app sent the bare national number, so the same person signing
    //* up on both created two records.
    const normalizedPhone = normalizePhone(phoneNumber);

    //* Can this number receive the SMS AT ALL — asked here, with the other input
    //* checks, and NOT left to sendSms below.
    //*
    //* sendSms runs after rateCheckAndUpsertOtp, which spends one of the day's
    //* OTPs for this number and arms the 60s resend cooldown. So a number
    //* Fast2SMS can never reach was told "use an Indian number" and then, if the
    //* same number came back within the minute, "please wait N seconds before
    //* requesting a new OTP" — a wait for a code that was never coming. Worse on
    //* mobile, where the phone field is a screen back and the error lands beside
    //* a live Submit button. Checked first, the doomed request costs nothing.
    //*
    //* Skipped in development so the escape hatch in the catch below (log the
    //* OTP, carry on) still lets these flows be exercised without a live gateway.
    if (process.env.NODE_ENV !== 'development') assertSmsDeliverable(normalizedPhone);

    //* Email and username are unique per account; a PHONE NUMBER IS NOT —
    //* several accounts may legitimately share one, so it is deliberately not
    //* checked here. Password reset asks which account is meant.
    //* Both checks are case-insensitive: the unique index is byte-wise, so
    //* "Foo@Gmail.com" and "foo@gmail.com" were two different keys to it and a
    //* duplicate slipped through. The previous email check also filtered on
    //* isEmailVerified:true, which made it a no-op for unverified accounts.
    const [existingEmail, existingUsername] = await Promise.all([
        User.findOne({ email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, 'i') }),
        User.findOne({ username: new RegExp(`^${escapeRegex(normalizedUsername)}$`, 'i') })
    ]);

    const errors = [];
    if (existingEmail) errors.push({ field: "email", message: "Email already in use" });
    if (existingUsername) errors.push({ field: "username", message: "Username already in use" });

    if (errors.length > 0) {
        const errorMessage = errors.map(err => err.message).join(", ");
        throw new ApiError(409, errorMessage, errors);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    //* The account itself is not created here — verifyRegistrationOTP creates
    //* it minutes later — so the consent has to travel with the pending signup.
    //* Captured NOW, because now is when the person actually ticked the box:
    //* the timestamp, the version-bearing acceptance and the IP all belong to
    //* this request, not to the later OTP screen.
    //*
    //* `ip` is LEGAL EVIDENCE, so it comes from extractClientMeta -> req.ip,
    //* which express resolves through `trust proxy`. Never the raw
    //* x-forwarded-for header, which is caller-supplied — guestAccount.js and
    //* legal.controllers.js state the same rule.
    const { ip: consentIp, userAgent: consentUserAgent } = extractClientMeta(req);

    await TempUser.findOneAndUpdate(
        { phoneNumber: normalizedPhone },
        {
            fullName,
            fullNameLower: fullName.toLowerCase(),
            username: normalizedUsername,
            email: normalizedEmail,
            password: hashedPassword,
            phoneNumber: normalizedPhone,
            dateOfBirth,
            gender: gender || 'prefer-not-to-say',
            //* Pending consent. Written with `strict: false` because these are
            //* not declared on TempUserSchema — see the note in
            //* verifyRegistrationOTP, which reads them back with .lean().
            legalConsentGiven:     signupConsent === true,
            legalConsentAt:        signupConsent === true ? new Date() : null,
            legalConsentIp:        signupConsent === true ? (consentIp || null) : null,
            legalConsentUserAgent: signupConsent === true ? (consentUserAgent || null) : null,
        },
        { upsert: true, new: true, strict: false }
    );

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    //* Registration used to write the OTP record directly, so it set
    //* `retryAfter` but never checked it and counted nothing: repeated calls
    //* to /register sent unlimited SMS. Now it goes through the same limiter
    //* as every other OTP — per-account per day, plus a per-IP cap.
    await rateCheckAndUpsertOtp({
        identifier: normalizedPhone,
        type: "phone",
        purpose: "registration",
        hashedOtp,
        expiry,
        ip: clientIp(req),
    });

    try {
        await sendSms({ phone: normalizedPhone, otp: plainOtp, request_type });
    } catch (smsErr) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[DEV] SMS failed (${smsErr.message}). OTP for ${normalizedPhone}: ${plainOtp}`);
        } else if (smsErr instanceof ApiError) {
            //* sendSms raises an ApiError for a number it can NEVER deliver to
            //* — currently anything non-Indian. That is a permanent fact about
            //* the number, not a gateway hiccup, so it keeps its own status and
            //* its own wording. Folded into the 503 below it would come out as
            //* "please try again", which cannot ever work, and the client would
            //* sit there retrying a request that is doomed by construction.
            throw smsErr;
        } else {
            throw new ApiError(503, `Failed to send OTP: ${smsErr.message}. Please try again or contact support.`);
        }
    }

    return res.status(200).json(
        //* Return the NORMALISED number: the client echoes it back to
        //* verify-otp, and the OTP is filed under this shape.
        new ApiResponse(200, { phone: normalizedPhone }, "OTP sent to your phone number. Please verify to complete registration.")
    );
});

const verifyRegistrationOTP = asyncHandler(async (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
        throw new ApiError(400, "Phone number and OTP are required");
    }

    //* Registration files the OTP under the normalised number, so normalise
    //* here too — otherwise a client echoing back the bare national number
    //* would not find the record it had just been sent.
    const normalizedPhone = normalizePhone(phone);

    const otpRecord = await AuthOtp.findOne({
        identifier: normalizedPhone,
        type: "phone",
        purpose: "registration",
    });

    if (!otpRecord) {
        throw new ApiError(404, "OTP not found. Please request a new one.");
    }

    if (new Date() > otpRecord.expiry) {
        await AuthOtp.deleteOne({ _id: otpRecord._id });
        throw new ApiError(400, "OTP has expired. Please request a new one.");
    }

    //* Same attempt budget as every other OTP path: a wrong code costs one of
    //* five and the record locks after that, instead of the code being free to
    //* guess for its whole five-minute life.
    assertOtpNotLocked(otpRecord);

    const isOtpValid = await otpRecord.verifyOtp(otp);
    if (!isOtpValid) {
        await registerFailedOtpAttempt(otpRecord);
    }

    //* .lean() — the raw driver document, not a hydrated model.
    //*
    //* registerUser parks the signup consent on this row (legalConsentGiven and
    //* friends) and those keys are NOT declared on TempUserSchema, so a
    //* hydrated document would drop them on read and the consent would be lost
    //* between the two halves of registration. Everything below reads plain
    //* fields off this object, so lean costs nothing.
    const tempUser = await TempUser.findOne({ phoneNumber: normalizedPhone }).lean();
    if (!tempUser) {
        throw new ApiError(404, "Registration session not found. Please register again.");
    }

    //* A TempUser row is keyed by PHONE NUMBER, so the same email and username
    //* can sit in two of them under two different numbers — sign up, fail to
    //* receive the SMS, sign up again from a second phone. registerUser checks
    //* both against existing accounts, but it ran minutes ago and against the
    //* other session, so it cannot see an account created in between.
    //*
    //* Once either session completed, verifying the other reached the unique
    //* index on `users` and threw a raw E11000 from the driver. That surfaced
    //* as an opaque 500, and because it threw BEFORE the cleanup below, the
    //* TempUser and the OTP both survived — so every retry failed identically.
    //* The signup could never be finished and never be abandoned.
    const wanted = {
        email: String(tempUser.email).trim().toLowerCase(),
        username: String(tempUser.username).trim().toLowerCase(),
    };

    const claimed = await User.findOne({
        $or: [
            { email: new RegExp(`^${escapeRegex(wanted.email)}$`, 'i') },
            { username: new RegExp(`^${escapeRegex(wanted.username)}$`, 'i') },
        ],
    });

    if (claimed) {
        //* Nothing about this session can ever succeed, so retire it rather
        //* than leaving it to fail the same way on the next attempt.
        await Promise.all([
            TempUser.deleteOne({ _id: tempUser._id }),
            AuthOtp.deleteOne({ _id: otpRecord._id }),
        ]);

        throw new ApiError(409,
            String(claimed.email).toLowerCase() === wanted.email
                ? "An account already exists for this email address. Please sign in, or reset your password if you have forgotten it."
                : "That username was taken while you were signing up. Please register again with a different username.");
    }

    //* The consent captured when the signup form was submitted. A client MAY
    //* also send the flag on THIS request — either one proves acceptance — so
    //* an older install that only learns to send it on one of the two calls
    //* still gets a record. Absent from both means an install that predates the
    //* checkbox entirely: it registers exactly as before, with nothing recorded
    //* as accepted, rather than being locked out of signup.
    const signupConsent =
        tempUser.legalConsentGiven === true || readSignupConsent(req.body) === true;

    const versions = await getAllEffectiveVersions();
    const requestMeta = extractClientMeta(req);
    //* Prefer the evidence captured at the moment of consent; fall back to this
    //* request for a client that consented here instead.
    const acceptanceIp = tempUser.legalConsentIp || requestMeta.ip;
    const acceptanceUserAgent = tempUser.legalConsentUserAgent || requestMeta.userAgent;
    const acceptedAt = tempUser.legalConsentAt ? new Date(tempUser.legalConsentAt) : new Date();

    const uid = uuidv4();
    //* This writes through User.collection — the RAW driver — so NONE of the
    //* schema setters run. `email` is declared `trim: true, lowercase: true`,
    //* but that only applies to Mongoose paths, so whatever case the user
    //* typed was stored verbatim. Every later lookup goes through the model
    //* (User.findOne({ email })), where Mongoose DOES lowercase the filter —
    //* so a stored "Foo@Gmail.com" could never be matched and the account was
    //* locked out of both email login and password reset. Normalise here.
    const newUserDoc = {
        uid,
        fullName: tempUser.fullName,
        fullNameLower: tempUser.fullNameLower,
        username: String(tempUser.username).trim().toLowerCase(),
        email: String(tempUser.email).trim().toLowerCase(),
        password: tempUser.password,
        phoneNumber: normalizePhone(tempUser.phoneNumber),
        dateOfBirth: tempUser.dateOfBirth,
        gender: tempUser.gender || 'prefer-not-to-say',
        isPhoneVerified: true,
        accountStatus: "active",
        isDeleted: false,
        deletedAt: null,
        adminActionReason: null,
        privacy: "public",
        isFullPrivate: false,
        isPhoneNumberHidden: false,
        isAddressHidden: false,
        isBusinessProfile: false,
        isBlueTickVerified: false,
        messagingPrivacy: { onlineStatus: "everyone", lastSeen: "everyone" },
        //* Written inline rather than through POST /legal/accept-signup: that
        //* endpoint needs a JWT, and there is no account to issue one against
        //* until the line below runs. EVERY key of the sub-document is set,
        //* because this insert bypasses the schema defaults — see
        //* buildSignupLegalAcceptance.
        legalAcceptance: buildSignupLegalAcceptance({
            accepted: signupConsent,
            versions,
            ip: acceptanceIp,
            userAgent: acceptanceUserAgent,
            acceptedAt,
        }),
        servicePostPreferences: { enableAutoFill: true },
        productPostPreferences: { enableAutoFill: true },
        followers: [],
        following: [],
        posts: [],
        fcmToken: null,
        fcmTokenUpdatedAt: null,
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    try {
        await User.collection.insertOne(newUserDoc);
    } catch (e) {
        //* The check above closes the window that stays open for minutes; this
        //* closes the one that stays open for milliseconds, when the same
        //* signup is verified twice at once. Same reasoning, same cleanup —
        //* without it the session would be left in the un-finishable state.
        if (e?.code === 11000) {
            await Promise.all([
                TempUser.deleteOne({ _id: tempUser._id }),
                AuthOtp.deleteOne({ _id: otpRecord._id }),
            ]);
            throw new ApiError(409,
                "An account with these details already exists. Please sign in.");
        }
        throw e;
    }

    const user = await User.findOne({ uid }).select("-password -refreshToken");

    await Promise.all([
        TempUser.deleteOne({ _id: tempUser._id }),
        AuthOtp.deleteOne({ _id: otpRecord._id }),
    ]);

    //* Audit trail, mirroring acceptAtSignup and guestAccount.js. Best effort:
    //* the account exists and is paid for in OTPs by this point, so a failure
    //* to write the log must not fail the signup — the acceptance itself is
    //* already on the user document above.
    if (signupConsent) {
        try {
            await AcceptanceLog.insertMany([
                { userId: user._id, docType: "TERMS",   version: versions.TERMS,   acceptedAt, ipAddress: acceptanceIp || null, userAgent: acceptanceUserAgent || null },
                { userId: user._id, docType: "PRIVACY", version: versions.PRIVACY, acceptedAt, ipAddress: acceptanceIp || null, userAgent: acceptanceUserAgent || null },
            ]);
        } catch (err) {
            console.error('[auth] Acceptance log write failed:', err.message);
        }
    }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const options = { httpOnly: true, secure: true };

    return res
        .status(201)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(
            new ApiResponse(201, { user, accessToken, refreshToken }, "Account created successfully")
        );
});

const resendRegistrationOTP = asyncHandler(async (req, res) => {
    const { phone } = req.body;
    const request_type = 'phonenumber_verify';

    if (!phone) {
        throw new ApiError(400, "Phone number is required");
    }

    const normalizedPhone = normalizePhone(phone);

    //* Before anything is charged for it — see registerUser above. A resend is
    //* where the old ordering hurt most: the cooldown armed by the previous
    //* request was still running, so the reply to an unreachable number was
    //* "please wait N seconds", not "this number cannot be used".
    if (process.env.NODE_ENV !== 'development') assertSmsDeliverable(normalizedPhone);

    const tempUser = await TempUser.findOne({ phoneNumber: normalizedPhone });
    if (!tempUser) {
        throw new ApiError(404, "Registration session not found. Please register again.");
    }

    const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await AuthOtp.hashOtp(plainOtp);
    const expiry     = new Date(Date.now() + OTP_EXPIRY_MS);

    //* Resend enforced the 60s cooldown but counted nothing, so a caller could
    //* sit on it and pull an OTP every minute forever. The shared limiter adds
    //* the per-account daily cap and the per-IP cap on top of that cooldown.
    await rateCheckAndUpsertOtp({
        identifier: normalizedPhone,
        type: "phone",
        purpose: "registration",
        hashedOtp,
        expiry,
        ip: clientIp(req),
    });

    //* Same handling as registerUser above. Unwrapped, a gateway failure threw
    //* a raw error that became a 500 — "something broke on our end" — when the
    //* truth is a 503: the SMS provider would not take it, and retrying may
    //* well work. The daily OTP cap has already been consumed by
    //* rateCheckAndUpsertOtp either way, so the person deserves to know which
    //* of the two it was.
    try {
        await sendSms({ phone: normalizedPhone, otp: plainOtp, request_type });
    } catch (smsErr) {
        if (process.env.NODE_ENV === 'development') {
            console.warn(`[DEV] SMS failed (${smsErr.message}). OTP for ${normalizedPhone}: ${plainOtp}`);
        } else if (smsErr instanceof ApiError) {
            //* Unsupported number, not a gateway failure — see registerUser.
            throw smsErr;
        } else {
            throw new ApiError(503, `Failed to send OTP: ${smsErr.message}. Please try again or contact support.`);
        }
    }

    return res.status(200).json(
        new ApiResponse(200, { retryAfterSeconds: 60 }, "OTP resent successfully")
    );
});

const loginUser = asyncHandler(async (req, res) => {
    const { email, username, password } = req.body;

    if (!email && !username) {
        throw new ApiError(400, "Please provide either email or username");
    }

    if (email && username) {
        throw new ApiError(400, "Please provide either email OR username, not both");
    }

    if (!password) {
        throw new ApiError(400, "Password is required");
    }

    // resolveUserByIdentifier matches case-insensitively, because registration
    // inserted through the raw driver and stored whatever case was typed —
    // Mongoose lowercases this filter, so those accounts were unreachable by
    // email. It also trims, so a stray space from an autofilled field cannot
    // break a username lookup.
    const user = await resolveUserByIdentifier(email || username);

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    //* This endpoint had no limiter of its own and the general one allows
    //* 50,000 requests a minute, so passwords could be sprayed at an account
    //* without resistance. Counted per ACCOUNT, not per IP: `x-forwarded-for`
    //* is caller-supplied, so an IP-keyed counter is beaten by rotating one
    //* header. The counter is cleared as soon as the right password arrives.
    await assertLoginAttemptsAvailable(user._id);

    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        await registerFailedLogin(user._id);
        throw new ApiError(401, "Invalid credentials");
    }

    await clearFailedLogins(user._id);

    if (user.isDeleted) {
        throw new ApiError(403, "Your account has been deleted. Please contact Find support.");
    }

    if (user.accountStatus === 'banned') {
        throw new ApiError(403, "Your account has been banned. Please contact Find support.");
    }

    if (user.accountStatus === 'deactivated') {
        throw new ApiError(403, "Your account has been deactivated. Please contact Find support.");
    }

    const { accessToken, refreshToken } = await generateAcessAndRefreshToken(user._id);
    const loggedUser = await User.findById(user._id).select("-password -refreshToken");

    const options = { httpOnly: true, secure: true };

    return res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(200, {
            user: loggedUser,
            accessToken,
            refreshToken
        }, "Login successful"));
});

const logOutUser = asyncHandler(async (req, res) => {
    // An FCM token addresses a PHYSICAL DEVICE, not an account. Left attached to
    // this user after they sign out, every push generated for THIS user —
    // message previews, incoming calls — still lands on that handset, in front
    // of whoever signs in next.
    //
    // But it is cleared ONLY when the caller proves it owns that device, by
    // sending the token it currently holds. This endpoint serves both clients,
    // and User.fcmToken stores the MOBILE token: an unconditional clear meant
    // signing out of the website on a laptop silently killed push notifications
    // on the user's phone, where they were still perfectly signed in. The web
    // client sends no token, matches nothing, and now leaves the phone alone.
    //
    // The login-side steal in saveFCMToken is the real backstop here — it runs
    // even when logout never does (crash, force-quit, expired token), so this
    // is defence in depth rather than the only line.
    //
    // NOTE: `null`, not `undefined`. Mongoose 8 strips undefined out of an
    // update before it reaches the driver (`{$set:{x:undefined}}` casts to
    // `{}`), so `undefined` would be a silent no-op. `null` is also the schema
    // default for this field.
    const deviceToken = typeof req.body?.fcmToken === "string"
        ? req.body.fcmToken.trim()
        : "";

    const update = { $set: { refreshToken: undefined } };
    const filter = { _id: req.user._id };
    if (deviceToken) {
        // Matched in the FILTER, not just assigned: if this user's stored token
        // is some other device's, the update simply does not apply, rather than
        // one handset's sign-out unhooking another's.
        filter.fcmToken = deviceToken;
        update.$set.fcmToken = null;
    }

    const cleared = await User.findOneAndUpdate(filter, update, { new: true });

    // Device register (Phase 3 #25): this account stops getting this device's
    // notifications; other accounts on the same phone keep theirs.
    if (deviceToken) {
        await UserDevice.deleteOne({ userId: req.user._id, token: deviceToken }).catch(() => {});
    }

    // The filtered update above matches nothing when the token was not this
    // user's (or none was sent), so refreshToken would go uncleared too. Run
    // the unconditional half separately in that case.
    if (!cleared) {
        await User.findByIdAndUpdate(
            req.user._id,
            { $set: { refreshToken: undefined } },
            { new: true }
        );
    }

    const options = { httpOnly: true, secure: true };

    return res
        .status(200)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "User logged Out Successfully"));
});

const checkTokenExpiry = asyncHandler(async (req, res) => {
    try {
        let token;

        if (req.cookies?.accessToken) {
            token = req.cookies.accessToken;
        } else if (req.headers?.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        if (!token) {
            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: true,
                    message: "No token provided"
                }, "Token status checked")
            );
        }

        try {
            const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
            const user = await User.findById(decodedToken?._id).select("-password -refreshToken");

            if (!user) {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: false,
                        message: "User no longer exists"
                    }, "Token status checked")
                );
            }

            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: true,
                    isExpired: false,
                    user: {
                        _id: user._id,
                        username: user.username,
                        fullName: user.fullName
                    },
                    expiresAt: new Date(decodedToken.exp * 1000),
                    message: "Token is valid"
                }, "Token status checked")
            );

        } catch (jwtError) {
            if (jwtError.name === 'TokenExpiredError') {
                return res.status(200).json(
                    new ApiResponse(200, {
                        isValid: false,
                        isExpired: true,
                        expiredAt: new Date(jwtError.expiredAt),
                        message: "Token has expired"
                    }, "Token status checked")
                );
            }

            return res.status(200).json(
                new ApiResponse(200, {
                    isValid: false,
                    isExpired: false,
                    message: "Invalid token"
                }, "Token status checked")
            );
        }

    } catch (error) {
        throw new ApiError(500, "Error checking token status: " + error.message);
    }
});

export {
    registerUser,
    verifyRegistrationOTP,
    resendRegistrationOTP,
    loginUser,
    logOutUser,
    checkTokenExpiry,
};
