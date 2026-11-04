import axios from 'axios';
import FormData from 'form-data';
import { ApiError } from '../utils/ApiError.js';

/**
 * Background removal through Photoroom (Phase 5 #35). Needs PHOTOROOM_API_KEY;
 * without it the feature reports itself as unavailable and nothing is sent
 * anywhere. The image goes through our server so the key never reaches a phone.
 */

export const photoroomConfigured = () => Boolean(process.env.PHOTOROOM_API_KEY);

const ENDPOINT = () => process.env.PHOTOROOM_API_URL || 'https://sdk.photoroom.com/v1/segment';

/** Returns a PNG with a transparent background. */
export const removeBackground = async (imageBuffer, { timeoutMs = 45000 } = {}) => {
    if (!photoroomConfigured()) throw new ApiError(503, 'Background removal is not available yet.');
    const form = new FormData();
    form.append('image_file', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    try {
        const res = await axios.post(ENDPOINT(), form, {
            headers: { ...form.getHeaders(), 'x-api-key': process.env.PHOTOROOM_API_KEY, Accept: 'image/png' },
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            maxBodyLength: Infinity,
            validateStatus: (s) => s === 200,
        });
        return Buffer.from(res.data);
    } catch (e) {
        const status = e.response?.status;
        // 402/403: out of credits or a bad key. Our problem, not the person's.
        if (status === 402 || status === 403 || status === 401) {
            console.error('[photoroom] account problem:', status);
            throw new ApiError(503, 'Background removal is not available right now.');
        }
        if (status === 400 || status === 422) throw new ApiError(422, "We couldn't find a clear subject in that photo.");
        throw new ApiError(502, 'Background removal took too long. Please try again.');
    }
};
