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
    
    const articles = await newsFetcher.fetchFeed();

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
    // DEBUG LOG: Confirm worker actually entered the function
    // logger.info(`⚙️ Processing Article Job [${job.id}]: "${job.data.title?.substring(0, 30)}..."`);

    try {
        const result = await newsFetcher.processArticleJob(job.data);
        
        if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
            await redisClient.del('feed:default:page0');
        } else {
            logger.info(`⚠️ Article Result [${job.id}]: ${result}`);
        }
        return result;
    } catch (err: any) {
        logger.error(`❌ Job Handler Failed [${job.id}]: ${err.message}`);
        throw err;
    }
};
