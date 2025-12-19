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
    // In threaded mode, this likely recycles the existing connection immediately.
    // If connection was lost, it reconnects.
    await dbLoader.connect();

    // 2. Route Job to Handler
    switch (job.name) {
        case 'update-trending':
            return await handleUpdateTrending(job);

        case 'fetch-feed':
        case 'scheduled-news-fetch':
        case 'manual-fetch':
            return await handleFetchFeed(job);

        case 'process-article':
            return await handleProcessArticle(job);

        default:
            logger.warn(`⚠️ Unknown Job Type in Processor: ${job.name}`);
            return null;
    }
}
