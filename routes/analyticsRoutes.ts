// narrative-backend/routes/analyticsRoutes.ts
import express from 'express';
import * as analyticsController from '../controllers/analyticsController';
import { checkAuth } from '../middleware/authMiddleware'; 

// Note: Most analytics endpoints are Public (no checkAuth) to allow tracking before login
// Admin endpoints like 'overview' are protected.

const router = express.Router();

// 1. Core Tracking (Heartbeat / Beacon)
router.post('/track', analyticsController.trackActivity);

// 2. Session Stitching (Link Guest -> User)
router.post('/link-session', analyticsController.linkSession);

// 3. User Stats (Personal Dashboard) - Protected
router.get('/user-stats', checkAuth, analyticsController.getUserStats);

// 4. Admin Overview (Protected)
router.get('/overview', checkAuth, analyticsController.getAnalyticsOverview);

// 5. Tune Feed (User Control) - Protected
// Allows user to remove negative filters or reset interests
router.post('/tune-feed', checkAuth, analyticsController.tuneUserFeed);

export default router;
