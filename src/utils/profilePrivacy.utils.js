/**
 * Profile location privacy (Phase 2 #12).
 *
 * A user's "Hide address" switch (User.isAddressHidden) hides BOTH their street
 * address and the free-text `location` line on their profile. The phone number
 * has its own switch and is never selected by the endpoints that show other
 * users, so only the location needs scrubbing here.
 *
 * Every endpoint that shows another user's location has to select
 * `isAddressHidden` alongside `location` and pass the result through
 * scrubHiddenLocation, or use publicUserPopulate for populated authors.
 * The owner's own reads (GET /users/profile) deliberately do NOT go through
 * this, so the edit-profile screen still shows what they typed.
 */

/** Blank the location/address of a user (lean object or Mongoose document) who hid it. */
export const scrubHiddenLocation = (user) => {
    if (user && typeof user === 'object' && user.isAddressHidden === true) {
        user.location = null;
        if ('address' in user) user.address = null;
    }
    return user;
};

/** Array form of scrubHiddenLocation; returns the same array. */
export const scrubHiddenLocations = (users) => {
    if (Array.isArray(users)) users.forEach(scrubHiddenLocation);
    return users;
};

/**
 * Populate options for an author field that includes `location`.
 * Adds isAddressHidden to the projection and scrubs the populated user.
 *
 *   .populate(publicUserPopulate('userId', 'username profileImageUrl location'))
 */
export const publicUserPopulate = (path, select) => ({
    path,
    select: `${select} isAddressHidden`,
    transform: (doc) => scrubHiddenLocation(doc),
});

/**
 * Query clauses that match a user by location/address only when they have not
 * hidden it, so a hidden location can't be discovered by searching for it.
 */
export const visibleLocationClauses = (regex, fields = ['location', 'address']) =>
    fields.map((field) => ({ [field]: regex, isAddressHidden: { $ne: true } }));
