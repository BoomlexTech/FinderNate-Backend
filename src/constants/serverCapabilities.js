/**
 * What this server can do that an older build of it could not.
 *
 * GET /api/v1/meta/app-version sends the list. The app and the website read it
 * before relying on something whose absence would do harm rather than just
 * show an error. The first such thing is a hidden service address: a server
 * from before that feature ignores `service.hideAddress` and would publish the
 * street address with the post, so a client sends the address only to a server
 * that says it keeps it private.
 *
 * Add a name when a feature like that ships; never remove or rename one.
 */
export const SERVER_CAPABILITIES = Object.freeze([
    // service.hideAddress is honoured: the address goes to ServicePrivateAddress.
    'service-hidden-address',
    // GET /meta/places/* (countries, states, cities, search, reverse).
    'places',
    // Sign-up codes by email as well as SMS (`otpMethod`).
    'signup-otp-method',
]);
