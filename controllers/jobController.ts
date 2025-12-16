// controllers/jobController.ts
import { Request, Response } from 'express';
import queueManager from '../jobs/queueManager';
import logger from '../utils/logger';

/**
 * Manually trigger the News Fetch pipeline.
 * Useful for admin testing or breaking news updates.
 */
export const triggerNewsFetch = async (req: Request, res: Response) => {
    try {
        const source = req.body.source || 'api';
        await queueManager.addFetchJob('manual-trigger', { source });
        
        logger.info(`👉 Manual News Fetch Triggered by IP: ${req.ip}`);
        res.status(202).json({ message: 'News fetch job added to queue.' });
    } catch (error: any) {
        logger.error(`❌ Failed to trigger manual job: ${error.message}`);
        res.status(500).json({ message: 'Failed to trigger job' });
    }
};
