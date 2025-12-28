// jobs/workerProcessor.ts
import { Job } from 'bullmq';
import logger from '../utils/logger';
import dbLoader from '../utils/dbLoader';
import { 
    handleUpdateTrending, 
    handleFetchFeed, 
    handleProcessArticle 
} from './jobHandlers';

/**
 * Worker Processor (Threaded Mode)
 * This function runs in the MAIN process now.
 * It is called directly by the worker, saving memory.
 */
export default async function workerProcessor(job: Job) {
    // 1. Ensure Database Connection
    await dbLoader.connect();

    // 2. Route Job to Handler
    switch (job.name) {
        case 'update-trending':
            return await handleUpdateTrending(job);

        // --- Fetch Handlers ---
        case 'fetch-feed':       // Legacy
        case 'fetch-feed-day':   // Current Day
        case 'fetch-feed-night': // Current Night
        case 'scheduled-news-fetch': // Legacy
        case 'cron-day':         // Zombie from logs
        case 'cron-night':       // Zombie from logs
        case 'manual-fetch':
            return await handleFetchFeed(job);

        // --- Processing Handlers ---
        case 'process-article':
            return await handleProcessArticle(job);

        default:
            logger.warn(`⚠️ Unknown Job Type in Processor: ${job.name}`);
            return null;
    }
}
