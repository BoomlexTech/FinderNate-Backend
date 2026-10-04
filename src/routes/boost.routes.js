import { Router } from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { createBoost, getMyBoosts, getBoostReport, cancelBoost } from '../controllers/boost.controllers.js';

const router = Router();

router.use(verifyJWT);

router.post('/', createBoost);               // POST   /api/v1/boosts
router.get('/mine', getMyBoosts);            // GET    /api/v1/boosts/mine
router.get('/:id/report', getBoostReport);   // GET    /api/v1/boosts/:id/report
router.delete('/:id', cancelBoost);          // DELETE /api/v1/boosts/:id

export default router;
