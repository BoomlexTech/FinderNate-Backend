import { ApiError } from "./ApiError.js";

export const SOCIAL_LINK_LIMIT = 10;

/**
 * Validates the social links a business publishes on its profile (#20):
 * at most 10, each { platform, url } with an http(s) URL. Blank rows from the
 * form are dropped rather than rejected.
 */
export const normalizeSocialLinks = (links) => {
    if (links === null) return [];
    if (!Array.isArray(links)) {
        throw new ApiError(400, "contact.socialMedia must be a list of { platform, url }");
    }
    const cleaned = links
        .filter((link) => link && typeof link.url === 'string' && link.url.trim())
        .map((link) => ({
            platform: typeof link.platform === 'string' ? link.platform.trim().toLowerCase().slice(0, 40) : 'website',
            url: link.url.trim(),
        }));
    if (cleaned.length > SOCIAL_LINK_LIMIT) {
        throw new ApiError(400, `You can add up to ${SOCIAL_LINK_LIMIT} social links`);
    }
    for (const link of cleaned) {
        if (!/^https?:\/\/[^\s]+$/i.test(link.url) || link.url.length > 500) {
            throw new ApiError(400, `Invalid link for ${link.platform}: it must start with http:// or https://`);
        }
    }
    return cleaned;
};
