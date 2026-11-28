import { ApiError } from "./ApiError.js";
import { getCoordinates } from "./getCoordinates.js";

const DELIVERY_OPTIONS = ['online', 'offline', 'both'];

/**
 * How a service reaches its customer, worked out from the service type when
 * the composer did not say. The service form no longer asks "online, offline
 * or both" (it was the same question as the service type, asked twice), so
 * the answer is read from the type: in-person -> offline, hybrid -> both,
 * online -> online.
 */
export const deliveryOptionsForServiceType = (serviceType) => {
    const type = String(serviceType || '').trim().toLowerCase();
    if (type === 'in-person' || type === 'offline') return 'offline';
    if (type === 'hybrid' || type === 'both') return 'both';
    return 'online';
};

/**
 * Checks the delivery option of a product, service or business post, and
 * finds the map point for its location when one was given.
 *
 * The location is OPTIONAL for every post type. It used to be mandatory for
 * offline / both delivery, and a street address the map service could not
 * place ("Shop 4, Ganesh Complex ...") refused the whole post. Now a post with
 * no location is simply a post with no location, and one whose address cannot
 * be placed is saved with the text and no map point.
 *
 * @param {Object} postData - Product, Service, or Business data (with `location`)
 * @param {string} postType - Type of post (product, service, business)
 * @returns {Object} The details, with deliveryOptions filled in and the location's coordinates when found
 */
export const validateDeliveryAndLocation = async (postData, postType) => {
    // Every caller passes an object literal `{ ...parsed, location: parsed }`,
    // which is truthy even when the client sent no product/service/business
    // object at all — so this guard could never fire and omitting the details
    // entirely fell through to the delivery check below with an empty object.
    // Test what the caller actually meant: whether there is anything in it.
    if (!postData || Object.keys(postData).every((k) => postData[k] === undefined || postData[k] === null)) {
        throw new ApiError(400, `${postType} details are required`);
    }

    const { location } = postData;
    let { deliveryOptions } = postData;

    if (!deliveryOptions && postType === 'service') {
        deliveryOptions = deliveryOptionsForServiceType(postData.serviceType);
    }

    if (!deliveryOptions) {
        throw new ApiError(400, "Delivery options (online/offline/both) are required");
    }

    if (!DELIVERY_OPTIONS.includes(deliveryOptions)) {
        throw new ApiError(400, "Delivery options must be 'online', 'offline', or 'both'");
    }

    // A location with some text and no map point yet: try to place it. Not
    // being able to is not an error.
    if (location && (location.name || location.address) && !location.coordinates) {
        try {
            // The full location object, so the lookup can fall back from the
            // street address to the city and state.
            const coords = await getCoordinates(location);
            if (coords?.latitude && coords?.longitude) {
                location.coordinates = {
                    type: "Point",
                    coordinates: [coords.longitude, coords.latitude]
                };
            }
        } catch (error) {
            console.warn(`Could not place the location of a ${postType} post on the map: ${error?.message || error}`);
        }
    }

    return { ...postData, deliveryOptions, location };
};

/**
 * Validates location format for business posts
 * @param {Object} location - Location object
 * @returns {boolean} True if valid
 */
export const isValidLocation = (location) => {
    if (!location) return false;

    // Must have either name or address
    if (!location.name && !location.address) return false;

    // If coordinates exist, validate GeoJSON format
    if (location.coordinates) {
        if (location.coordinates.type !== 'Point') return false;
        if (!Array.isArray(location.coordinates.coordinates)) return false;
        if (location.coordinates.coordinates.length !== 2) return false;

        const [lng, lat] = location.coordinates.coordinates;
        if (typeof lng !== 'number' || typeof lat !== 'number') return false;
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
    }

    return true;
};

/**
 * A location is never required any more (see validateDeliveryAndLocation).
 * Kept, returning false, for any caller that still asks.
 * @returns {boolean} Always false
 */
export const isLocationRequired = () => false;

/**
 * Sanitize and prepare location data for database storage
 * @param {Object} location - Raw location data
 * @returns {Object} Sanitized location data
 */
export const sanitizeLocationData = (location) => {
    if (!location) return null;

    const sanitized = {};

    // Copy allowed fields
    if (location.name) sanitized.name = location.name.trim();
    if (location.address) sanitized.address = location.address.trim();
    if (location.city) sanitized.city = location.city.trim();
    if (location.state) sanitized.state = location.state.trim();
    if (location.country) sanitized.country = location.country.trim();

    // Copy coordinates if valid
    if (location.coordinates && isValidLocation({ coordinates: location.coordinates })) {
        sanitized.coordinates = location.coordinates;
    }

    return sanitized;
};

export default {
    validateDeliveryAndLocation,
    deliveryOptionsForServiceType,
    isValidLocation,
    isLocationRequired,
    sanitizeLocationData
};
