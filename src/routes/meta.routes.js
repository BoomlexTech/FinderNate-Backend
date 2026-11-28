import { Router } from "express";
import { getContentCategories } from "../controllers/discovery.controllers.js";
import { unsubscribeEmail } from "../controllers/email.controllers.js";
import { getAppVersion } from "../controllers/appUpdate.controllers.js";
import { getCountries, getStates, getCities, searchAllPlaces, reversePlace } from "../controllers/places.controllers.js";
import { placesLookupRateLimit } from "../middlewares/rateLimiter.middleware.js";

// Public lists and links (Phase 2): content categories (#26) and the digest
// email's unsubscribe link (#10).
export const metaRouter = Router();
metaRouter.get("/categories", getContentCategories);
// The newest app version announced to users, for the app's "Update available"
// notice. Public: it is asked before anyone is signed in.
metaRouter.get("/app-version", getAppVersion);

// Places: the Country > State > City lists, a search that reaches towns,
// villages and local areas, and the address at a GPS position ("Use my
// current location"). Public, like the lists above: sign-up and guest
// checkout use them. The two that can reach OpenStreetMap are rate limited.
metaRouter.get("/places/countries", getCountries);
metaRouter.get("/places/states", getStates);
metaRouter.get("/places/cities", getCities);
metaRouter.get("/places/search", placesLookupRateLimit, searchAllPlaces);
metaRouter.get("/places/reverse", placesLookupRateLimit, reversePlace);

export const emailRouter = Router();
emailRouter.route("/unsubscribe").get(unsubscribeEmail).post(unsubscribeEmail);
