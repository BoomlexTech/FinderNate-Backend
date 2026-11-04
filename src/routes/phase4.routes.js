import express from 'express';
import { verifyJWT, optionalVerifyJWT } from '../middlewares/auth.middleware.js';
import {
    getBusinessKyc, submitBusinessKyc, businessAadhaarOtp, businessAadhaarVerify,
    userAadhaarOtp, userAadhaarVerify, getMyKyc, resendDetailsConfirmation, confirmDetailsFromEmail, getTrustInfo,
} from '../controllers/kyc.controllers.js';
import { getAdConfig, createAd, myAds, getAd, cancelAd, serveAds, adImpression, adClick } from '../controllers/ads.controllers.js';
import { listingConfig, createListing, myListings, cancelListing } from '../controllers/listings.controllers.js';
import {
    createPlatformCheckout, verifyPlatformPayment, platformPaymentWebhook, confirmPlayPurchase,
    getPlatformPaymentConfig, myPlatformPurchases,
} from '../controllers/platformPayments.controllers.js';
import { getBusinessViews, getStatements, getPlusStatus, seoSitemap, seoPost, seoBusiness } from '../controllers/businessGrowth.controllers.js';

// Phase 4 (business trust, money and SEO). See docs/PHASE4_API.md.

export const kycRouter = express.Router();
kycRouter.get('/business/confirm-details', confirmDetailsFromEmail); // email link, public
kycRouter.use(verifyJWT);
kycRouter.get('/business', getBusinessKyc);
kycRouter.post('/business', submitBusinessKyc);
kycRouter.post('/business/aadhaar/otp', businessAadhaarOtp);
kycRouter.post('/business/aadhaar/verify', businessAadhaarVerify);
kycRouter.post('/business/send-confirmation', resendDetailsConfirmation);
kycRouter.get('/me', getMyKyc);
kycRouter.post('/me/aadhaar/otp', userAadhaarOtp);
kycRouter.post('/me/aadhaar/verify', userAadhaarVerify);
kycRouter.get('/trust/:userId', getTrustInfo);

export const adsRouter = express.Router();
adsRouter.get('/serve', optionalVerifyJWT, serveAds);
adsRouter.post('/:id/impression', optionalVerifyJWT, adImpression);
adsRouter.post('/:id/click', optionalVerifyJWT, adClick);
adsRouter.use(verifyJWT);
adsRouter.get('/config', getAdConfig);
adsRouter.get('/mine', myAds);
adsRouter.post('/', createAd);
adsRouter.get('/:id', getAd);
adsRouter.delete('/:id', cancelAd);

export const listingsRouter = express.Router();
listingsRouter.use(verifyJWT);
listingsRouter.get('/config', listingConfig);
listingsRouter.get('/mine', myListings);
listingsRouter.post('/', createListing);
listingsRouter.delete('/:id', cancelListing);

export const platformPayRouter = express.Router();
platformPayRouter.post('/webhook', platformPaymentWebhook);
platformPayRouter.use(verifyJWT);
platformPayRouter.get('/config', getPlatformPaymentConfig);
platformPayRouter.get('/mine', myPlatformPurchases);
platformPayRouter.post('/verify', verifyPlatformPayment);
platformPayRouter.post('/:kind/checkout', createPlatformCheckout);
platformPayRouter.post('/:kind/play', confirmPlayPurchase);

export const growthRouter = express.Router();
growthRouter.use(verifyJWT);
growthRouter.get('/views', getBusinessViews);
growthRouter.get('/statements', getStatements);
growthRouter.get('/plus', getPlusStatus);

export const seoRouter = express.Router();
seoRouter.get('/sitemap', seoSitemap);
seoRouter.get('/post/:id', seoPost);
seoRouter.get('/business/:username', seoBusiness);
