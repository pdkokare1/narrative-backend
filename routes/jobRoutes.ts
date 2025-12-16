// routes/jobRoutes.ts
import express, { Request, Response, NextFunction } from 'express';
import queueManager from '../jobs/queueManager';
import logger from '../utils/logger';
import config from '../utils/config';

const router = express.Router();

// Middleware: Verify Admin Secret for ALL job routes
const requireAdminSecret = (req: Request, res: Response, next: NextFunction) => {
    // Check for key in Query String (?key=...) OR Headers
    const key = (req.query.key as string) || req.headers['x-admin-key'];
    
    if (key !== config.adminSecret) {
        logger.warn(`🚫 Unauthorized Job Access Attempt: ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized. Invalid Admin Key." });
    }
    next();
};

router.use(requireAdminSecret);

// --- 1. Manual News Fetch Trigger (Now GET for easy browser access) ---
// Usage: https://api.thegamut.in/api/jobs/fetch-news?key=YOUR_SECRET&region=US
router.get('/fetch-news', async (req: Request, res: Response) => {
    const region = req.query.region as string; // Optional: 'US', 'IN', etc.
    
    try {
        await queueManager.addFetchJob('manual-fetch', { region });
        logger.info(`👋 Manual News Fetch Triggered (Region: ${region || 'Default'})`);
        res.json({ 
            status: 'success', 
            message: 'News fetch job started in background.', 
            region: region || 'Default' 
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- 2. Manual Trending Update (Now GET) ---
// Usage: https://api.thegamut.in/api/jobs/update-trending?key=YOUR_SECRET
router.get('/update-trending', async (req: Request, res: Response) => {
    try {
        await queueManager.addFetchJob('update-trending', {});
        logger.info(`👋 Manual Trending Update Triggered`);
        res.json({ 
            status: 'success', 
            message: 'Trending update job started.' 
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- 3. Queue Status ---
// Usage: https://api.thegamut.in/api/jobs/status?key=YOUR_SECRET
router.get('/status', async (req: Request, res: Response) => {
    const stats = await queueManager.getStats();
    res.json(stats);
});

export default router;
