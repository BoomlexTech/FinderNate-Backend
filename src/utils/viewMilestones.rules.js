/** Pure view-milestone rules (Phase 2 #46). */

/** Thresholds reached by `views` that haven't been announced yet. Pure. */
export const milestonesToAnnounce = (views, thresholds, alreadyAnnounced = []) => {
    const done = new Set((alreadyAnnounced || []).map(Number));
    return [...new Set((thresholds || []).map(Number))]
        .filter((t) => Number.isFinite(t) && t > 0 && views >= t && !done.has(t))
        .sort((a, b) => a - b);
};

export const milestoneMessage = (threshold) =>
    `Your listing reached ${threshold} views. It's gaining attention, consider boosting it`;
