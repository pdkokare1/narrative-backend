// narrative-backend/routes/analyticsRoutes.ts
import express from 'express';
import * as analyticsController from '../controllers/analyticsController';
import { checkAuth, checkAdmin } from '../middleware/authMiddleware';

const router = express.Router();

// Public route (User doesn't need to be logged in to be tracked)
router.post('/track', analyticsController.trackActivity);

// Admin route
router.get('/overview', checkAuth, checkAdmin, analyticsController.getAnalyticsOverview);

export default router;
