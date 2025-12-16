// jobs/scheduler.ts
import queueManager from './queueManager';
import logger from '../utils/logger';

const initScheduler = async () => {
    logger.info('⏳ Initializing Distributed Scheduler (BullMQ)...');

    // 1. News Fetch: Daytime (Every 30 mins at :00 and :30, from 5 AM to 10 PM)
    await queueManager.scheduleRepeatableJob('cron-day', '0,30 5-22 * * *', { source: 'cron-day' });

    // 2. News Fetch: Night Mode (At 23:00, 01:00, 03:00)
    await queueManager.scheduleRepeatableJob('cron-night', '0 23,1,3 * * *', { source: 'cron-night' });

    // 3. Trending Topics: Update every 30 minutes (Offset by 15 mins)
    // Runs at :15 and :45 to avoid spiking the CPU alongside the News Fetch
    await queueManager.scheduleRepeatableJob('update-trending', '15,45 * * * *', {});
    
    logger.info('✅ Scheduled Jobs Registered in Redis');
};

export default { init: initScheduler };
