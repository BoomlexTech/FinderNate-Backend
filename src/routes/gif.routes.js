import express from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { searchGifs, trendingGifs } from '../controllers/gif.controllers.js';

// GIF and sticker search through our GIPHY proxy (Phase 3 #7).
const router = express.Router();
router.use(verifyJWT);
router.get('/search', searchGifs);
router.get('/trending', trendingGifs);

export default router;
