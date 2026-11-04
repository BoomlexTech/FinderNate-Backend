import sharp from 'sharp';
import { parseHexColor } from './phase5.rules.js';

/**
 * The photo enhancer's image work (Phase 5 #35). Free, runs on this server:
 * lighting is lifted only as far as the photo needs, contrast is stretched,
 * colour is nudged up a little and the picture is sharpened.
 */

const MAX_EDGE = 2048;

/** How much brighter a photo of this average luminance (0..255) should be made. 1 = leave it. */
export const brightnessLift = (luminance) => {
    if (!Number.isFinite(luminance)) return 1;
    const lift = 1 + ((115 - luminance) / 255) * 1.2;
    return Math.min(1.5, Math.max(1, Math.round(lift * 1000) / 1000));
};

export const luminanceOf = (stats) => {
    const [r, g, b] = stats.channels;
    if (!r || !g || !b) return stats.channels[0]?.mean ?? 128;
    return 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean;
};

/** Lighting fix + sharpening. Returns { buffer, width, height, format: 'jpeg' }. */
export const enhanceLocally = async (input) => {
    const base = sharp(input, { failOn: 'none' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    const prepared = await base.toBuffer();
    const stats = await sharp(prepared).resize(256, 256, { fit: 'inside' }).stats();
    const lift = brightnessLift(luminanceOf(stats));
    const out = await sharp(prepared)
        .normalise({ lower: 1, upper: 99 })
        .modulate({ brightness: lift, saturation: 1.08 })
        .sharpen({ sigma: 1.1, m1: 0.6, m2: 1.6 })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    return { buffer: out.data, width: out.info.width, height: out.info.height, format: 'jpeg', lift };
};

/** A cut-out PNG placed on a plain colour (default white), or kept transparent. */
export const placeOnBackground = async (pngBuffer, background = '#ffffff') => {
    if (String(background).toLowerCase() === 'transparent') {
        const out = await sharp(pngBuffer).png().toBuffer({ resolveWithObject: true });
        return { buffer: out.data, width: out.info.width, height: out.info.height, format: 'png' };
    }
    const rgb = parseHexColor(background) || { r: 255, g: 255, b: 255 };
    const out = await sharp(pngBuffer)
        .flatten({ background: rgb })
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    return { buffer: out.data, width: out.info.width, height: out.info.height, format: 'jpeg' };
};

/** Size-limits an upload before it is sent to the background-removal service. */
export const prepareForCutout = async (input) =>
    sharp(input, { failOn: 'none' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
