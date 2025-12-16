// routes/jobRoutes.ts
import express, { Request, Response } from 'express';
import queueManager from '../jobs/queueManager';
import logger from '../utils/logger';
import config from '../utils/config';

const router = express.Router();

// Middleware: Verify Admin Secret for ALL job routes
const requireAdminSecret = (req: Request, res: Response, next: express.NextFunction) => {
    const key = req.query.key as string;
    
    if (key !== config.adminSecret) {
        logger.warn(`🚫 Unauthorized Job Access Attempt: ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized. Invalid Admin Key." });
    }
    next();
};

router.use(requireAdminSecret);

// --- 1. Manual News Fetch Trigger ---
router.post('/fetch-news', async (req: Request, res: Response) => {
    const { region } = req.body; // Optional: 'US', 'IN', etc.
    
    try {
        await queueManager.addFetchJob('manual-fetch', { region });
        logger.info(`👋 Manual News Fetch Triggered (Region: ${region || 'Default'})`);
        res.json({ message: 'News fetch job started in background.' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- 2. Manual Trending Update ---
router.post('/update-trending', async (req: Request, res: Response) => {
    try {
        await queueManager.addFetchJob('update-trending', {});
        logger.info(`👋 Manual Trending Update Triggered`);
        res.json({ message: 'Trending update job started.' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- 3. Queue Status ---
router.get('/status', async (req: Request, res: Response) => {
    const stats = await queueManager.getStats();
    res.json(stats);
});

export default router;
