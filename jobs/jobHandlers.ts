// jobs/jobHandlers.ts
import { Job } from 'bullmq';
import logger from '../utils/logger';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import queueManager from './queueManager';

/**
 * Handler: Update Trending Topics
 * Recalculates trending topics based on recent article clusters.
 */
export const handleUpdateTrending = async (job: Job) => {
    logger.info(`👷 Job ${job.id}: Updating Trending Topics...`);
    await statsService.updateTrendingTopics();
    return { status: 'completed' };
};

/**
 * Handler: Fetch Feed (Batch Producer)
 * Fetches news from external APIs and creates individual processing jobs.
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
 * Runs the AI Pipeline for a single article.
 */
export const handleProcessArticle = async (job: Job) => {
    // This calls the pipeline service (which handles deduplication & analysis)
    const result = await newsFetcher.processArticleJob(job.data);
    
    // LOGGING: Explicitly log the result since the Worker suppresses completion logs
    if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
        // Success is logged in Pipeline, no need to duplicate spam
    } else {
        logger.info(`⚠️ Article Result [${job.id}]: ${result}`);
    }
    
    return result;
};
