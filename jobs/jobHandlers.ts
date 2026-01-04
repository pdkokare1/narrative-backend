// jobs/jobHandlers.ts
import { Job } from 'bullmq';
import logger from '../utils/logger';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import queueManager from './queueManager';
import redisClient from '../utils/redisClient';

/**
 * Handler: Update Trending Topics
 */
export const handleUpdateTrending = async (job: Job) => {
    logger.info(`👷 Job ${job.id}: Updating Trending Topics...`);
    await statsService.updateTrendingTopics();
    return { status: 'completed' };
};

/**
 * Handler: Fetch Feed (Batch Producer)
 */
export const handleFetchFeed = async (job: Job) => {
    logger.info(`👷 Job ${job.id}: Fetching Feed (${job.name})...`);
    
    // 1. Fetch Raw Articles (with Batch Embeddings pre-calculated)
    const articles = await newsFetcher.fetchFeed();

    // 2. Dispatch to Batch Processing Queue
    if (articles.length > 0) {
        const jobs = articles.map(article => ({
            name: 'process-article',
            data: article,
            opts: { 
                removeOnComplete: true,
                attempts: 3 
            }
        }));

        await queueManager.addBulk(jobs);
        logger.info(`✨ Dispatched ${articles.length} individual article jobs to Batch Engine.`);
    }

    return { status: 'dispatched', count: articles.length };
};

/**
 * Handler: Process Single Article (Consumer)
 */
export const handleProcessArticle = async (job: Job) => {
    // Explicit Start Log
    logger.info(`⚙️ Processing Pipeline Starting [${job.id}]`);

    try {
        // This calls the pipeline service (deduplication & analysis)
        const result = await newsFetcher.processArticleJob(job.data);
        
        // Success Logic
        if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
            // FIX: Invalidate Feed Cache immediately so new content appears on Frontend
            await redisClient.del('feed:default:page0');
            logger.info(`✅ Article Saved [${job.id}]: ${result}`);
        } else {
            logger.info(`⚠️ Article Skipped/Result [${job.id}]: ${result}`);
        }
        
        return result;

    } catch (error: any) {
        logger.error(`❌ Pipeline Failed [${job.id}]: ${error.message}`);
        throw error; // Throw to trigger BullMQ retry
    }
};
