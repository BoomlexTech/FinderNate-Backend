import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import Setting from '../../models/settings.models.js';
import { ALLOWED_SETTING_KEYS } from '../../constants/settings.js';
import { validateSettingValue } from './settings.helpers.js';
import { clearSettingCache } from '../../utils/appSettings.utils.js';

// POST /admin/settings  — add a new key (fails if key already exists)
export const addSetting = asyncHandler(async (req, res) => {
    const { key, value } = req.body;

    if (!key || value === undefined) {
        throw new ApiError(400, 'key and value are required');
    }

    if (!ALLOWED_SETTING_KEYS.includes(key)) {
        throw new ApiError(400, `Invalid key. Allowed keys: ${ALLOWED_SETTING_KEYS.join(', ')}`);
    }

    const { valid, message } = validateSettingValue(key, value);
    if (!valid) throw new ApiError(400, message);

    const existing = await Setting.findOne({ key });
    if (existing) {
        throw new ApiError(409, `Setting '${key}' already exists. Use update to modify it.`);
    }

    const setting = await Setting.create({ key, value, updatedBy: req.admin._id });
    clearSettingCache(key);

    return res
        .status(201)
        .json(new ApiResponse(201, setting, 'Setting added successfully'));
});

// GET /admin/settings/:key  — fetch a single setting by key
export const getSetting = asyncHandler(async (req, res) => {
    const { key } = req.params;

    if (!ALLOWED_SETTING_KEYS.includes(key)) {
        throw new ApiError(400, `Invalid key. Allowed keys: ${ALLOWED_SETTING_KEYS.join(', ')}`);
    }

    const setting = await Setting.findOne({ key });
    if (!setting) {
        throw new ApiError(404, `Setting '${key}' not found`);
    }

    return res
        .status(200)
        .json(new ApiResponse(200, setting, 'Setting fetched successfully'));
});

// GET /admin/settings  — fetch all settings
export const getAllSettings = asyncHandler(async (req, res) => {
    const settings = await Setting.find({});
    return res
        .status(200)
        .json(new ApiResponse(200, settings, 'Settings fetched successfully'));
});

// PUT /admin/settings/:key  — update an existing setting's value
export const updateSetting = asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (!ALLOWED_SETTING_KEYS.includes(key)) {
        throw new ApiError(400, `Invalid key. Allowed keys: ${ALLOWED_SETTING_KEYS.join(', ')}`);
    }

    if (value === undefined) {
        throw new ApiError(400, 'value is required');
    }

    const { valid, message } = validateSettingValue(key, value);
    if (!valid) throw new ApiError(400, message);

    const setting = await Setting.findOneAndUpdate(
        { key },
        { value, updatedBy: req.admin._id },
        { new: true }
    );

    if (!setting) {
        throw new ApiError(404, `Setting '${key}' not found. Use add to create it.`);
    }
    clearSettingCache(key);

    return res
        .status(200)
        .json(new ApiResponse(200, setting, 'Setting updated successfully'));
});
