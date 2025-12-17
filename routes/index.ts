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

// --- 1. System & Admin Routes (Protected) ---
router.use('/jobs', checkAdmin, jobRoutes);
router.use('/migration', checkAdmin, migrationRoutes);
router.use('/cluster', checkAdmin, clusterRoutes);
router.use('/assets', checkAdmin, assetGenRoutes); 

// --- 2. User Protected Routes ---
router.use('/profile', checkAppCheck, checkAuth, profileRoutes);
router.use('/activity', checkAppCheck, checkAuth, activityRoutes);

// --- 3. Public / Hybrid Routes ---
router.use('/emergency-resources', emergencyRoutes);
router.use('/tts', ttsLimiter, ttsRoutes);

// --- 4. Main Content Routes ---
// Mounted at root to maintain API compatibility:
// /api/articles, /api/trending, /api/search
router.use('/', articleRoutes);

// --- 5. API 404 Handler ---
// Catches any request that didn't match the routes above
router.use('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        message: "API Endpoint Not Found", 
        path: req.originalUrl 
    });
});

export default router;
