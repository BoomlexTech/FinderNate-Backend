import ServicePrivateAddress from '../models/servicePrivateAddress.models.js';

/**
 * "Hide address" on a service post.
 *
 * The composer sends the address in the post's `location` (name, address,
 * city, state, country) and the choice as `service.hideAddress`. When it is
 * on, the street address and the map point worked out from it are taken out of
 * everything that is stored on the post, and the address alone is kept in
 * ServicePrivateAddress, which only the owner can read. The city, state and
 * the place name the owner chose to tag stay public: they say roughly where
 * the service is, not where the door is.
 */

/** True when the owner asked for the address to be hidden. Form posts send text. */
export const readHideAddress = (service) =>
    service?.hideAddress === true || service?.hideAddress === 'true';

/** A location without its street address, postcode and exact map point. */
export const withoutStreetAddress = (location) => {
    if (!location || typeof location !== 'object') return location;
    // eslint-disable-next-line no-unused-vars
    const { address, postalCode, coordinates, ...rest } = location;
    return rest;
};

/**
 * Splits what the composer sent into what goes on the post and what stays
 * private. `location` is the post's top-level location; `service` is the
 * service details object.
 *
 * @returns {{ service: object, location: object|undefined, hideAddress: boolean, privateAddress: string }}
 *   `privateAddress` is '' when there is nothing to keep.
 */
export const splitServiceAddress = (service, location) => {
    const hideAddress = readHideAddress(service);
    // Only when there ARE service details: an absent `service` must stay
    // absent, so the "service details are required" check still sees nothing.
    const publicService = service && typeof service === 'object' ? { ...service, hideAddress } : service;

    if (!hideAddress) {
        return { service: publicService, location, hideAddress, privateAddress: '' };
    }

    const privateAddress = String(location?.address || service?.location?.address || '').trim();
    if (publicService?.location) publicService.location = withoutStreetAddress(publicService.location);

    return {
        service: publicService,
        location: withoutStreetAddress(location),
        hideAddress,
        privateAddress
    };
};

/** Keeps (or replaces) the hidden address of a post. `session` is optional. */
export const savePrivateServiceAddress = (postId, userId, address, session = null) =>
    ServicePrivateAddress.findOneAndUpdate(
        { postId },
        { $set: { userId, address: String(address || '').trim() } },
        { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
    );

/** The hidden address of a post, for its owner. '' when there is none. */
export const getPrivateServiceAddress = async (postId, userId) => {
    if (!postId || !userId) return '';
    const row = await ServicePrivateAddress.findOne({ postId, userId }).select('address').lean();
    return row?.address || '';
};

export const deletePrivateServiceAddress = (postId) =>
    ServicePrivateAddress.deleteOne({ postId });

/**
 * Where a service is, for a checkout card or any other place a buyer sees.
 * Never the street address when it is hidden.
 */
export const publicServicePlace = (service) => {
    const location = service?.location;
    if (!location) return '';
    if (readHideAddress(service)) return location.city || location.state || '';
    return location.name || location.address || location.city || '';
};
