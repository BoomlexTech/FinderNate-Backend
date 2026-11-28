import { User } from '../models/user.models.js';

/**
 * Findernate Plus is the subscription for personal accounts. While it is
 * active the account sees no ads and no boosted posts, and carries the blue
 * tick on its profile.
 *
 * The tick is the same `isBlueTickVerified` flag both clients already draw, so
 * no client needs to learn a new field. Two things keep it honest:
 *
 *  - `blueTickFromPlus` records that the tick came with Plus. That is what lets
 *    it be taken away when Plus ends without touching a tick an admin granted
 *    by hand (PUT /admin/users/:userId/blue-tick), which has it false.
 *  - the profile endpoints work the tick out at read time (hasBlueTick), so it
 *    appears the moment Plus is paid for and goes the moment it lapses, rather
 *    than at the next run of the daily job below.
 */

/** Plus has been paid for and has not run out. */
export const isPlusActive = (user, now = new Date()) =>
    !!(user?.plusUntil && new Date(user.plusUntil) > now);

/**
 * Whether the blue tick shows for this user. Needs `plusUntil`,
 * `blueTickFromPlus` and `isBlueTickVerified` on the object.
 */
export const hasBlueTick = (user, now = new Date()) => {
    if (isPlusActive(user, now)) return true;
    // The tick came with Plus, and Plus has ended.
    if (user?.blueTickFromPlus === true) return false;
    return user?.isBlueTickVerified === true;
};

/** The same question for a user id (one small read). */
export const isPlusActiveForUserId = async (userId) => {
    if (!userId) return false;
    const user = await User.findById(userId).select('plusUntil').lean();
    return isPlusActive(user);
};

/**
 * Store the tick when Plus is activated. An account an admin already verified
 * is left exactly as it is, so its tick still stands after Plus ends.
 */
export const grantPlusTick = (userId) =>
    User.updateOne(
        { _id: userId, isBlueTickVerified: { $ne: true } },
        { $set: { isBlueTickVerified: true, blueTickFromPlus: true } }
    );

/**
 * Bring the stored flag in line with who has Plus right now. Lists that read
 * the stored flag directly (search, payment pages) follow from this. Run by
 * the Plus job; safe to run at any time and as often as wanted.
 */
export const syncPlusTicks = async (now = new Date()) => {
    const [granted, revoked] = await Promise.all([
        User.updateMany(
            { plusUntil: { $gt: now }, isBlueTickVerified: { $ne: true } },
            { $set: { isBlueTickVerified: true, blueTickFromPlus: true } }
        ),
        User.updateMany(
            { blueTickFromPlus: true, $or: [{ plusUntil: null }, { plusUntil: { $lte: now } }] },
            { $set: { isBlueTickVerified: false, blueTickFromPlus: false } }
        )
    ]);
    return { granted: granted?.modifiedCount || 0, revoked: revoked?.modifiedCount || 0 };
};
