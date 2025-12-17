// jobs/scheduler.ts
import logger from '../utils/logger';
import queueManager from './queueManager';

/**
 * Distributed Scheduler (Redis + BullMQ)
 * Ensures jobs run exactly once across all server instances.
 */
export const startScheduler = async () => {
  logger.info('⏰ Initializing Distributed Scheduler...');

  // --- 1. News Fetch Job (Every 2 Hours) ---
  await queueManager.scheduleRepeatableJob(
    'fetch-feed', 
    '0 */2 * * *', 
    { type: 'auto-fetch', source: 'scheduler' }
  );

  // --- 2. Trending Topics Update (Every 4 Hours) ---
  await queueManager.scheduleRepeatableJob(
    'update-trending',
    '30 */4 * * *',
    { type: 'stats-update' }
  );

  // --- 3. Startup Check ---
  // Triggers an initial fetch 5 seconds after boot.
  // The queueManager's smart-check prevents this from duplicating if multiple workers exist.
  setTimeout(() => {
    logger.info('🚀 Startup: Triggering initial News Fetch check...');
    queueManager.addFetchJob('fetch-feed', { reason: 'startup' });
  }, 5000);
};
