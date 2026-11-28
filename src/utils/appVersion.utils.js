/**
 * Version arithmetic for "is there an update for this phone?".
 *
 * No I/O and no imports, so it can be unit tested and used by the controller
 * and the push sender alike. Versions are the app's version NAME ("4.9.33"),
 * optionally followed by "+build" as Flutter prints it ("4.9.33+4093300"); the
 * build is ignored, because the name is what people and the Play Store show.
 */

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.findernate.app';

/** "4.9.33+4093300" -> [4, 9, 33]. Null when it is not a version at all. */
export const parseVersion = (value) => {
    const text = String(value ?? '').trim().split('+')[0].replace(/^v/i, '');
    if (!/^\d+(\.\d+){0,3}$/.test(text)) return null;
    return text.split('.').map((part) => Number.parseInt(part, 10));
};

/** -1, 0 or 1. A version that cannot be read sorts as the oldest. */
export const compareVersions = (a, b) => {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left && !right) return 0;
    if (!left) return -1;
    if (!right) return 1;
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
};

/**
 * Should a phone on `installed` be told about `latest`?
 *
 * A phone that has never said which version it runs (every build before the
 * one that started sending it) is older than any version announced from now
 * on, so it is told.
 */
export const needsUpdate = (installed, latest) => {
    if (!parseVersion(latest)) return false;
    if (!parseVersion(installed)) return true;
    return compareVersions(installed, latest) < 0;
};

/** The tray text for an update, one place so the push and the tests agree. */
export const updateNotificationText = (version, notes = '') => {
    const cleanNotes = String(notes || '').trim();
    return {
        title: 'Update available',
        body: cleanNotes
            ? `Findernate ${version} is ready: ${cleanNotes} Tap to update.`
            : `Findernate ${version} is ready. Tap to update from Google Play.`
    };
};
