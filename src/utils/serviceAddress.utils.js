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

const foldPlaceText = (value) =>
    String(value ?? '').toLowerCase().replace(/[\s,.;:/#()-]+/g, ' ').trim();

/**
 * True when a place name gives the street address away: it is the address,
 * holds it, or is a piece of it ("12 MG Road" tagged as the place of a post
 * whose address is "12 MG Road, Baner, Pune").
 */
export const nameRevealsAddress = (name, address) => {
    const n = foldPlaceText(name);
    const a = foldPlaceText(address);
    if (!n || !a) return false;
    return n === a || n.includes(a) || a.includes(n);
};

/**
 * A location without its street address, postcode and exact map point.
 *
 * The place name stays only when it does not repeat the address. A composer
 * that had no separate place to tag used to fill `name` with the address
 * itself, and keeping that would publish what the owner asked to hide. A name
 * that is dropped, or was never given, becomes the city and state, so the
 * post still says roughly where the service is.
 */
export const withoutStreetAddress = (location) => {
    if (!location || typeof location !== 'object') return location;
    // eslint-disable-next-line no-unused-vars
    const { address, postalCode, coordinates, ...rest } = location;
    const name = String(rest.name ?? '').trim();
    if (!name || nameRevealsAddress(name, address)) {
        const area = [rest.city, rest.state].map((part) => String(part ?? '').trim()).filter(Boolean).join(', ');
        if (area) rest.name = area;
        else delete rest.name;
    }
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
