import { ApiError } from "./ApiError.js";

export const SOCIAL_LINK_LIMIT = 10;

/**
 * Adds "https://" to a link typed without one ("mybusiness.com",
 * "www.instagram.com/me", "//site.in"). People type links that way, and the
 * form used to answer "Invalid URL" instead of fixing it. A value that already
 * starts with http:// or https:// is left alone; a blank one stays blank.
 */
export const withProtocol = (value) => {
    if (typeof value !== 'string') return value;
    const v = value.trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('//')) return `https:${v}`;
    return `https://${v.replace(/^[a-z]+:\/*/i, '')}`;
};

/** True for an http(s) link with a host that has a dot in it ("https://a.in/x"). */
export const isWebLink = (value) =>
    typeof value === 'string' && value.length <= 500 && /^https?:\/\/[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$/i.test(value);

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
            url: withProtocol(link.url),
        }));
    if (cleaned.length > SOCIAL_LINK_LIMIT) {
        throw new ApiError(400, `You can add up to ${SOCIAL_LINK_LIMIT} social links`);
    }
    for (const link of cleaned) {
        if (!isWebLink(link.url)) {
            throw new ApiError(400, `The ${link.platform} link doesn't look like a web address (example: instagram.com/yourname)`);
        }
    }
    return cleaned;
};
