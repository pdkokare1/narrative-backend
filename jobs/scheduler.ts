// jobs/scheduler.ts
import queueManager from './queueManager';
import logger from '../utils/logger';

const initScheduler = async () => {
    logger.info('⏳ Initializing Distributed Scheduler (BullMQ)...');

    // 1. News Fetch: Daytime (Every 30 mins from 5 AM to 10 PM)
    await queueManager.scheduleRepeatableJob('cron-day', '*/30 5-22 * * *', { source: 'cron-day' });

    // 2. News Fetch: Night Mode (23:00, 01:00, 03:00)
    await queueManager.scheduleRepeatableJob('cron-night', '0 23,1,3 * * *', { source: 'cron-night' });

    // 3. Trending Topics: Update every 30 minutes
    // Now runs via the queue worker to prevent duplicate processing on multiple servers
    await queueManager.scheduleRepeatableJob('update-trending', '*/30 * * * *', {});
    
    logger.info('✅ Scheduled Jobs Registered in Redis');
};

export default { init: initScheduler };
