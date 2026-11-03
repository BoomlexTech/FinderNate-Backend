import express from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { upload } from '../middlewares/multerConfig.js';
import { e2eeBackupReadRateLimit } from '../middlewares/rateLimiter.middleware.js';
import {
    registerE2eeDevice,
    listMyE2eeDevices,
    revokeE2eeDevice,
    getE2eeKeys,
    uploadE2eeBlob,
    getE2eeBackup,
    putE2eeBackup,
    deleteE2eeBackup,
} from '../controllers/e2ee.controllers.js';

// End-to-end encryption (Phase 3 #2, #40). See docs/PHASE3_API.md.
const router = express.Router();
router.use(verifyJWT);

router.get('/devices', listMyE2eeDevices);
router.put('/devices/:deviceId', registerE2eeDevice);
router.delete('/devices/:deviceId', revokeE2eeDevice);
router.get('/keys', getE2eeKeys);
router.post('/blobs', upload.single('file'), uploadE2eeBlob);
router.get('/backup', e2eeBackupReadRateLimit, getE2eeBackup);
router.put('/backup', putE2eeBackup);
router.delete('/backup', deleteE2eeBackup);

export default router;
