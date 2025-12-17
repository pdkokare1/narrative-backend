// jobs/scheduler.ts
import logger from '../utils/logger';
import queueManager from './queueManager';

/**
 * Distributed Scheduler (Redis + BullMQ)
 * Replaces node-cron to ensure jobs run exactly once across all server instances.
 */
export const startScheduler = async () => {
  logger.info('⏰ Initializing Distributed Scheduler...');

  // --- 1. News Fetch Job (Every 2 Hours) ---
  // Cron Expression: "0 */2 * * *" -> At minute 0 past every 2nd hour.
  await queueManager.scheduleRepeatableJob(
    'fetch-feed', 
    '0 */2 * * *', 
    { type: 'auto-fetch', source: 'scheduler' }
  );

  // --- 2. Trending Topics Update (Every 4 Hours) ---
  // Cron Expression: "30 */4 * * *" -> At minute 30 past every 4th hour.
  await queueManager.scheduleRepeatableJob(
    'update-trending',
    '30 */4 * * *',
    { type: 'stats-update' }
  );

  // --- 3. Startup Check ---
  // Optional: Trigger an immediate fetch 5 seconds after boot if it's a fresh deployment.
  setTimeout(() => {
    logger.info('🚀 Startup: Triggering initial News Fetch...');
    // We use the new job name 'fetch-feed'
    queueManager.addFetchJob('fetch-feed', { reason: 'startup' });
  }, 5000);
};
