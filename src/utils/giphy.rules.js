/** Pure GIPHY response shaping (Phase 3 #7), kept free of Redis so it can be unit tested. */

/** Keeps only GIPHY's https media links. */
const httpsOnly = (u) => (typeof u === 'string' && u.startsWith('https://') ? u.split('?')[0] : undefined);

/** The fields our clients need, in one shape for GIFs and stickers. */
export const normalizeGif = (g, type = 'gifs') => {
    if (!g || !g.id || !g.images) return null;
    const main = g.images.fixed_height || g.images.original || {};
    const preview = g.images.fixed_height_small || g.images.fixed_width_small || g.images.preview_gif || main;
    const url = httpsOnly(main.webp) || httpsOnly(main.url);
    if (!url) return null;
    return {
        provider: 'giphy',
        id: String(g.id),
        type: type === 'stickers' || g.is_sticker ? 'sticker' : 'gif',
        title: String(g.title || '').slice(0, 140),
        url,
        mp4Url: httpsOnly(main.mp4),
        previewUrl: httpsOnly(preview.webp) || httpsOnly(preview.url) || url,
        width: Number(main.width) || null,
        height: Number(main.height) || null,
    };
};

