// jobs/jobHandlers.ts
import { Job } from 'bullmq';
import logger from '../utils/logger';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
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
 * Handler: Fetch Feed & Process Immediately (Inline Batch)
 */
export const handleFetchFeed = async (job: Job) => {
    logger.info(`👷 Job ${job.id}: Fetching Feed (${job.name})...`);
    
    // 1. Fetch Raw Articles
    const articles = await newsFetcher.fetchFeed();

    if (articles.length === 0) {
        return { status: 'empty', count: 0 };
    }

    logger.info(`⚡ Starting Inline Processing for ${articles.length} articles...`);

    let successCount = 0;
    let failCount = 0;

    // 2. Process Sequentially (Inline)
    // This bypasses the queue "black hole" issue entirely.
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        const progressPrefix = `[${i + 1}/${articles.length}]`;

        try {
            logger.info(`🔄 ${progressPrefix} Processing: "${article.title?.substring(0, 30)}..."`);
            
            // Call the processor directly
            const result = await newsFetcher.processArticleJob(article);

            if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
                successCount++;
                logger.info(`✅ ${progressPrefix} Success: ${result}`);
            } else {
                logger.info(`⚠️ ${progressPrefix} Skipped: ${result}`);
            }

            // Report progress to BullMQ to prevent timeouts
            await job.updateProgress(Math.round(((i + 1) / articles.length) * 100));

        } catch (err: any) {
            failCount++;
            logger.error(`❌ ${progressPrefix} Failed: ${err.message}`);
            // Continue to next article - don't stop the whole batch
        }
    }

    // 3. Invalidate Cache if we saved anything
    if (successCount > 0) {
        await redisClient.del('feed:default:page0');
        logger.info(`🧹 Feed Cache Invalidated. New content available.`);
    }

    logger.info(`🏁 Batch Complete. Success: ${successCount}, Failed: ${failCount}`);
    return { status: 'completed', success: successCount, failed: failCount };
};

/**
 * Handler: Process Single Article
 * (Kept as fallback, but mostly unused now with Inline logic)
 */
export const handleProcessArticle = async (job: Job) => {
    logger.info(`⚙️ Processing Pipeline Starting [${job.id}]`);
    try {
        const result = await newsFetcher.processArticleJob(job.data);
        if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
            await redisClient.del('feed:default:page0');
        }
        return result;
    } catch (error: any) {
        logger.error(`❌ Pipeline Failed [${job.id}]: ${error.message}`);
        throw error;
    }
};
