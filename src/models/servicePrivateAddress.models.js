import mongoose from 'mongoose';

/**
 * The street address of a service post whose owner chose "Hide address".
 *
 * It lives in its own collection, NOT on the post, on purpose. Posts are
 * returned by dozens of endpoints (feeds, explore, search, profiles, saved
 * posts, share pages, checkout cards), several of them aggregation pipelines
 * that ignore `select: false`. Stripping a field in every one of them, and in
 * every one added later, is a promise that only holds until someone forgets.
 * A post that never contains the address cannot leak it.
 *
 * Only the post's owner can read a row (GET /posts/:postId/service-address,
 * and the owner's own GET /posts/:postId).
 */
const ServicePrivateAddressSchema = new mongoose.Schema({
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    address: { type: String, default: '', trim: true, maxlength: 500 }
}, { timestamps: true });

export default mongoose.model('ServicePrivateAddress', ServicePrivateAddressSchema);
