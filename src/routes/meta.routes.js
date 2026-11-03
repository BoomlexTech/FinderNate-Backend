import { Router } from "express";
import { getContentCategories } from "../controllers/discovery.controllers.js";
import { unsubscribeEmail } from "../controllers/email.controllers.js";

// Public lists and links (Phase 2): content categories (#26) and the digest
// email's unsubscribe link (#10).
export const metaRouter = Router();
metaRouter.get("/categories", getContentCategories);

export const emailRouter = Router();
emailRouter.route("/unsubscribe").get(unsubscribeEmail).post(unsubscribeEmail);
