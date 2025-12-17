// routes/index.ts
import express from 'express';
import { checkAuth, checkAppCheck, checkAdmin } from '../middleware/authMiddleware';
import { ttsLimiter } from '../middleware/rateLimiters';

// Import Routes
import profileRoutes from './profileRoutes';
import activityRoutes from './activityRoutes';
import articleRoutes from './articleRoutes';
import emergencyRoutes from './emergencyRoutes';
import ttsRoutes from './ttsRoutes';
import migrationRoutes from './migrationRoutes';
import assetGenRoutes from './assetGenRoutes';
import clusterRoutes from './clusterRoutes';
import jobRoutes from './jobRoutes';

const router = express.Router();

// --- System & Admin Routes (Protected) ---
router.use('/jobs', checkAdmin, jobRoutes);
router.use('/migration', checkAdmin, migrationRoutes);
router.use('/cluster', checkAdmin, clusterRoutes);
router.use('/assets', checkAdmin, assetGenRoutes); 

// --- User Protected Routes ---
router.use('/profile', checkAppCheck, checkAuth, profileRoutes);
router.use('/activity', checkAppCheck, checkAuth, activityRoutes);

// --- Public / Hybrid Routes ---
router.use('/emergency-resources', emergencyRoutes);
router.use('/tts', ttsLimiter, ttsRoutes);

// --- Main Article Routes (Catch-all for API) ---
// Note: This is mounted last because it likely contains root paths like "/" or "/:id"
router.use('/', articleRoutes);

export default router;
