// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import queueManager from './queueManager';
import statsService from '../services/statsService';

const initScheduler = () => {
    logger.info('⏳ Initializing Background Scheduler...');

    // 1. News Fetch: Daytime (Every 30 mins from 5 AM to 10 PM)
    cron.schedule('*/30 5-22 * * *', async () => { 
        logger.info('☀️ Scheduled Job: Daytime Fetch');
        await queueManager.addFetchJob('cron-day', { source: 'cron-day' });
    });

    // 2. News Fetch: Night Mode (23:00, 01:00, 03:00)
    cron.schedule('0 23,1,3 * * *', async () => {
        logger.info('🌙 Scheduled Job: Night Fetch');
        await queueManager.addFetchJob('cron-night', { source: 'cron-night' });
    });

    // 3. Trending Topics: Update every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        await statsService.updateTrendingTopics();
    });
    
    logger.info('✅ Scheduler Active');
};

export default { init: initScheduler };
