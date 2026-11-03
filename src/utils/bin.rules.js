/** Pure Bin rules behind utils/bin.utils.js (Phase 2 #15). */

/** What the Bin screen shows for an item. Pure. */
export const binPreviewOf = (kind, doc) => {
    if (kind === 'story') {
        return {
            postType: 'story',
            contentType: 'normal',
            caption: doc.caption || doc.sharedPost?.caption || '',
            thumbnailUrl: doc.sharedPost?.thumbnailUrl || (doc.mediaType === 'image' ? doc.mediaUrl : null),
            mediaType: doc.mediaType || 'image',
        };
    }
    const first = doc.media?.[0];
    return {
        postType: doc.postType,
        contentType: doc.contentType,
        caption: doc.caption || doc.customization?.product?.name || doc.customization?.service?.name || doc.description || '',
        thumbnailUrl: first ? (first.thumbnailUrl || (first.type === 'image' ? first.url : null)) : null,
        mediaType: first?.type || null,
    };
};

/** Every CDN file a binned item owns. Reposted stories own none. Pure. */
export const mediaUrlsOf = (kind, doc) => {
    if (kind === 'story') return doc.sharedPost?.postId ? [] : [doc.mediaUrl].filter(Boolean);
    const urls = [];
    for (const m of doc.media || []) {
        if (m.url) urls.push(m.url);
        if (m.thumbnailUrl) urls.push(m.thumbnailUrl);
        for (const a of m.additionalMedia || []) {
            if (a.url) urls.push(a.url);
            if (a.thumbnailUrl) urls.push(a.thumbnailUrl);
        }
    }
    return urls;
};

/** When a restored story should be: still live, or kept in the archive. Pure. */
export const restoredStoryState = (doc, now = new Date()) => {
    const expired = !doc.expiresAt || new Date(doc.expiresAt) <= now;
    return expired ? { isArchived: true } : {};
};
