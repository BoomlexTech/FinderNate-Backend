// The platform's own online-store seller account. A normal User row whose
// products are created through the ordinary post endpoints, so anything that
// meters sellers by plan (post quota, product catalogue cap) has to exempt it by
// id. Kept in one place so the store controller and the plan limits cannot
// disagree about who it is.
export const PLATFORM_STORE_USER_ID = '69ba39e7ee60e4c9277fb780';

export const isPlatformStoreUser = (userId) =>
    !!userId && String(userId) === PLATFORM_STORE_USER_ID;
