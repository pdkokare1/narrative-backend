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
 * Sandboxed Worker Processor
 * * This function runs in a separate process (sandbox). 
 * It isolates the CPU-intensive work from the main thread.
 */
export default async function workerProcessor(job: Job) {
    // 1. Ensure Database Connection
    // Since this runs in a separate process, it needs its own connection.
    // dbLoader handles the "is already connected" check internally.
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
