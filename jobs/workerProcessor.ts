// jobs/workerProcessor.ts
import { Job } from 'bullmq';
import mongoose from 'mongoose';
import logger from '../utils/logger';
import dbLoader from '../utils/dbLoader';
import { 
    handleUpdateTrending, 
    handleFetchFeed, 
    handleProcessArticle,
    handleSmartNotifications,
    handleUpdateVector // NEW: Imported
} from './jobHandlers';

/**
 * Worker Processor (Threaded Mode)
 * This function runs in the MAIN process.
 */
export default async function workerProcessor(job: Job) {
    // DEBUG: Confirm job pickup immediately
    if (job.name === 'process-article') {
        logger.info(`📥 Worker Picked Up: "${job.data.title?.substring(0, 40)}..." (ID: ${job.id})`);
    }

    // 1. Ensure Database Connection (Safe Check) - RESTORED
    // In threaded mode, we might already be connected.
    if (mongoose.connection.readyState !== 1) {
        await dbLoader.connect();
    }

    // 2. Route Job to Handler
    try {
        switch (job.name) {
            case 'update-trending':
                return await handleUpdateTrending(job);

            case 'fetch-feed':       
            case 'fetch-feed-day':   
            case 'fetch-feed-night': 
            case 'manual-fetch':
                return await handleFetchFeed(job);

            case 'process-article':
                return await handleProcessArticle(job);

            // NEW: Smart Notifications Handler
            case 'smart-notifications':
                return await handleSmartNotifications(job);

            // NEW: Vector Update Handler
            case 'update-user-vector':
                return await handleUpdateVector(job);

            case 'daily-cleanup':
                // No-op or handled directly in scheduler, but good to have a safe return
                return { status: 'skipped' };

            default:
                logger.warn(`⚠️ Unknown Job Type in Processor: ${job.name}`);
                return null;
        }
    } catch (error: any) {
        logger.error(`❌ Worker Processor Error [${job.name}]: ${error.message}`);
        throw error;
    }
}
