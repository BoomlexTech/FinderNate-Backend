import express from 'express';
import { verifyJWT, optionalVerifyJWT } from '../middlewares/auth.middleware.js';
import { getBlockedUsers } from '../middlewares/blocking.middleware.js';
import {
    listSounds, mySavedSounds, getSound, getSoundPosts, saveSound, unsaveSound, updateMySound,
} from '../controllers/sounds.controllers.js';
import {
    getEditConfig, receiveEditFiles, createEdit, createDuetEdit, getEdit, discardEdit,
} from '../controllers/edits.controllers.js';
import { getEnhanceConfig, receiveEnhanceImage, enhancePhoto } from '../controllers/enhance.controllers.js';

// Phase 5 (creator tools). See docs/PHASE5_API.md.

export const soundsRouter = express.Router();
soundsRouter.get('/', optionalVerifyJWT, listSounds);
soundsRouter.get('/saved', verifyJWT, mySavedSounds);
soundsRouter.get('/:id', optionalVerifyJWT, getSound);
soundsRouter.get('/:id/posts', optionalVerifyJWT, getBlockedUsers, getSoundPosts);
soundsRouter.post('/:id/save', verifyJWT, saveSound);
soundsRouter.delete('/:id/save', verifyJWT, unsaveSound);
soundsRouter.patch('/:id', verifyJWT, updateMySound);

export const editsRouter = express.Router();
editsRouter.use(verifyJWT);
editsRouter.get('/config', getEditConfig);
editsRouter.post('/', receiveEditFiles, createEdit);
editsRouter.post('/duet', receiveEditFiles, createDuetEdit);
editsRouter.get('/:id', getEdit);
editsRouter.delete('/:id', discardEdit);

export const enhanceRouter = express.Router();
enhanceRouter.use(verifyJWT);
enhanceRouter.get('/config', getEnhanceConfig);
enhanceRouter.post('/', receiveEnhanceImage, enhancePhoto);
