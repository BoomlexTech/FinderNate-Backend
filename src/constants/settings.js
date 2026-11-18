// Allowed setting keys — only keys listed here can be stored via the settings API
export const SETTING_KEYS = {
    GATEWAY_FEE: 'GATEWAY_FEE',       // Payment gateway fee percentage (e.g. 0.02 = 2%)
    PLATFORM_FEE: 'PLATFORM_FEE',     // Platform fee percentage (e.g. 0.025 = 2.5%)
    // Phase 2
    CONTENT_CATEGORIES: 'CONTENT_CATEGORIES', // ["Comedy", "Technology", ...] for the category picker (#26)
    VIEW_MILESTONES: 'VIEW_MILESTONES',       // [50, 100, 500] listing view thresholds (#46)
    BIN_RETENTION_DAYS: 'BIN_RETENTION_DAYS', // 15 (#15)
    // Prices the code already reads but admins could not set (the settings API
    // refused every key not listed here).
    LISTING_FEE_30: 'LISTING_FEE_30',   // ₹ before GST, one-time product listing for 30 days (#80)
    LISTING_FEE_60: 'LISTING_FEE_60',   // ₹ before GST, 60 days
    PLUS_PLAN_PRICE: 'PLUS_PLAN_PRICE', // ₹ before GST, plan for regular users (#77)
    AD_DAILY_FEE: 'AD_DAILY_FEE',       // ₹ per day before GST (#29)
    ADS_ENABLED: 'ADS_ENABLED',         // true / false
    // Lock "End-to-end encrypted" shown in one-to-one chats (client item #14).
    E2EE_INDICATOR: 'E2EE_INDICATOR',   // true / false
};

export const ALLOWED_SETTING_KEYS = Object.values(SETTING_KEYS);

// Expected JS typeof for each key's value
export const SETTING_KEY_TYPES = {
    GATEWAY_FEE:  'number',
    PLATFORM_FEE: 'number',
    CONTENT_CATEGORIES: 'string[]',
    VIEW_MILESTONES: 'number[]',
    BIN_RETENTION_DAYS: 'number',
    LISTING_FEE_30: 'number',
    LISTING_FEE_60: 'number',
    PLUS_PLAN_PRICE: 'number',
    AD_DAILY_FEE: 'number',
    ADS_ENABLED: 'boolean',
    E2EE_INDICATOR: 'boolean',
};

/**
 * Used when a setting has never been saved. Listings were switched off until
 * someone set the fees, which the admin panel could not do; these switch them
 * on (client item #21). Saving a value in admin overrides them.
 */
export const DEFAULT_LISTING_FEES = Object.freeze({ 30: 99, 60: 149 });
export const DEFAULT_E2EE_INDICATOR = true;
