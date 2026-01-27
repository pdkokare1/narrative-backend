// jobs/jobHandlers.ts
import { Job } from 'bullmq';
import logger from '../utils/logger';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import redisClient from '../utils/redisClient';
import notificationService from '../services/notificationService'; 
import UserStats from '../models/userStatsModel';

/**
 * Handler: Update Trending Topics
 */
export const handleUpdateTrending = async (job: Job) => {
    logger.info(`👷 Job ${job.id}: Updating Trending Topics...`);
    await statsService.updateTrendingTopics();
    return { status: 'completed' };
};

/**
 * Handler: Smart Notifications
 * Finds users whose peak activity is NOW and sends a briefing.
 */
export const handleSmartNotifications = async (job: Job) => {
    const currentHour = new Date().getHours().toString();
    logger.info(`🔔 Checking Smart Notifications for Hour: ${currentHour}`);

    try {
        // 1. Find users who are active at this hour
        // Query: users where activityByHour.currentHour > 100 seconds (meaning they actually use it then)
        const activeUsers = await UserStats.find({
            [`activityByHour.${currentHour}`]: { $gt: 100 }
        }).select('userId activityByHour');

        logger.info(`🎯 Found ${activeUsers.length} potential users for Hour ${currentHour}`);

        let sentCount = 0;
        for (const userStat of activeUsers) {
            // 2. Dispatch Smart Alert
            const sent = await notificationService.sendSmartAlert(userStat.userId, currentHour);
            if (sent) sentCount++;
        }

        return { status: 'completed', sent: sentCount };
    } catch (error: any) {
        logger.error(`❌ Smart Notification Error: ${error.message}`);
        throw error;
    }
};

/**
 * Handler: Daily Interest Decay
 * Reduces the weight of old interests for all users to keep recommendations fresh.
 */
export const handleDailyDecay = async (job: Job) => {
    logger.info(`📉 Starting Daily Interest Decay for all users...`);
    
    try {
        // Fetch all user stats (Just IDs to save memory)
        // In a large scale app, this should be a cursor or batched.
        const allStats = await UserStats.find({}).select('userId');
        
        logger.info(`👥 Applying decay to ${allStats.length} user profiles.`);

        let processed = 0;
        for (const stat of allStats) {
            await statsService.applyInterestDecay(stat.userId);
            processed++;
        }

        logger.info(`✅ Decay Complete. Processed ${processed} users.`);
        return { status: 'completed', count: processed };

    } catch (error: any) {
        logger.error(`❌ Interest Decay Failed: ${error.message}`);
        throw error;
    }
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
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        const progressPrefix = `[${i + 1}/${articles.length}]`;

        try {
            logger.info(`🔄 ${progressPrefix} Processing: "${article.title?.substring(0, 30)}..."`);
            
            const result = await newsFetcher.processArticleJob(article);

            if (result === 'SAVED_FRESH' || result === 'SAVED_INHERITED') {
                successCount++;
                logger.info(`✅ ${progressPrefix} Success: ${result}`);
            } else {
                logger.info(`⚠️ ${progressPrefix} Skipped: ${result}`);
            }

            await job.updateProgress(Math.round(((i + 1) / articles.length) * 100));

        } catch (err: any) {
            failCount++;
            logger.error(`❌ ${progressPrefix} Failed: ${err.message}`);
        }
    }

    if (successCount > 0) {
        await redisClient.del('feed:default:page0');
        logger.info(`🧹 Feed Cache Invalidated. New content available.`);
    }

    logger.info(`🏁 Batch Complete. Success: ${successCount}, Failed: ${failCount}`);
    return { status: 'completed', success: successCount, failed: failCount };
};

/**
 * Handler: Process Single Article
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
