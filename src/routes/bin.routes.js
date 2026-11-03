import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { listBin, restoreBinItem, deleteBinItemNow, emptyBin } from "../controllers/bin.controllers.js";

// The Bin (Phase 2 #15): deleted posts, vibes, notes and stories, kept 15 days.
const router = Router();
router.route("/").get(verifyJWT, listBin).delete(verifyJWT, emptyBin);
router.post("/:binId/restore", verifyJWT, restoreBinItem);
router.delete("/:binId", verifyJWT, deleteBinItemNow);
export default router;
