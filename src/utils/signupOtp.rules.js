/**
 * Where the sign-up code is sent: 'phone' (an SMS) or 'email'.
 *
 * The person picks one on the sign-up form and the client sends it as
 * `otpMethod`. 'phone' is the default, and what every app and browser build
 * from before the choice gets: those send no `otpMethod` at all and expect the
 * SMS they always got.
 *
 * No imports, so the rule can be unit tested on its own.
 */
export const SIGNUP_OTP_METHODS = Object.freeze(['phone', 'email']);

/** The method named in a request body, or null when it names none. */
export const requestedSignupOtpMethod = (body) => {
    const raw = String(body?.otpMethod ?? body?.verifyVia ?? '').trim().toLowerCase();
    if (raw === 'email') return 'email';
    if (raw === 'phone' || raw === 'sms' || raw === 'mobile') return 'phone';
    return null;
};

/** The method to use for a request: the one it names, else SMS. */
export const readSignupOtpMethod = (body) => requestedSignupOtpMethod(body) || 'phone';

/**
 * The method for a resend: the one asked for now; else the one the sign-up
 * started with; else SMS. Asking for the other one here is how "send it to my
 * email instead" works.
 */
export const resendSignupOtpMethod = (body, startedWith) =>
    requestedSignupOtpMethod(body) || (startedWith === 'email' ? 'email' : 'phone');

/** Which contact channels a finished sign-up has proven. */
export const verifiedFlagsFor = (otpMethod) => ({
    isPhoneVerified: otpMethod === 'phone',
    isEmailVerified: otpMethod === 'email'
});
