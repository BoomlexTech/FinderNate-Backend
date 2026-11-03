import { SETTING_KEY_TYPES } from '../../constants/settings.js';

/**
 * Validates that `value` matches the expected type for `key`.
 * Returns { valid: true } or { valid: false, message: string }.
 */
export function validateSettingValue(key, value) {
    const expectedType = SETTING_KEY_TYPES[key];
    if (!expectedType) {
        return { valid: false, message: `No type rule defined for key '${key}'` };
    }

    // Lists (Phase 2): a non-empty array of strings or of non-negative numbers.
    if (expectedType === 'string[]' || expectedType === 'number[]') {
        const itemType = expectedType.slice(0, -2);
        if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
            return { valid: false, message: `'${key}' expects a list of 1 to 100 ${itemType}s` };
        }
        const bad = value.find((v) => typeof v !== itemType
            || (itemType === 'string' && (!v.trim() || v.length > 40))
            || (itemType === 'number' && (!Number.isFinite(v) || v < 0)));
        if (bad !== undefined) {
            return { valid: false, message: `'${key}' has an invalid entry: ${JSON.stringify(bad)}` };
        }
        return { valid: true };
    }

    const actualType = typeof value;

    if (actualType !== expectedType) {
        return {
            valid: false,
            message: `'${key}' expects a ${expectedType}, got ${actualType}`,
        };
    }

    // Extra numeric sanity checks for fee keys
    if (expectedType === 'number') {
        if (isNaN(value) || !isFinite(value)) {
            return { valid: false, message: `'${key}' must be a finite number` };
        }
        if (value < 0) {
            return { valid: false, message: `'${key}' must be non-negative` };
        }
    }

    return { valid: true };
}
