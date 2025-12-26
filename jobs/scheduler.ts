// jobs/scheduler.ts
import logger from '../utils/logger';
import queueManager from './queueManager';

/**
 * Distributed Scheduler (Redis + BullMQ)
 * Ensures jobs run exactly once across all server instances.
 */
export const startScheduler = async () => {
  logger.info('⏰ Initializing Distributed Smart Scheduler...');

  // --- 1. Day Mode: High Frequency (6:00 AM - 11:59 PM) ---
  // Runs every 30 minutes to catch breaking news during active hours
  await queueManager.scheduleRepeatableJob(
    'fetch-feed-day', 
    '*/30 6-23 * * *', 
    { type: 'auto-fetch', source: 'scheduler-day' }
  );

  // --- 2. Night Mode: Low Frequency (12:00 AM - 5:59 AM) ---
  // Runs every 2 hours (00:00, 02:00, 04:00) to save resources
  await queueManager.scheduleRepeatableJob(
    'fetch-feed-night',
    '0 0-5/2 * * *',
    { type: 'auto-fetch', source: 'scheduler-night' }
  );

  // --- 3. Trending Topics Update (Every 2 Hours) ---
  await queueManager.scheduleRepeatableJob(
    'update-trending',
    '30 */2 * * *',
    { type: 'stats-update' }
  );

  // --- 4. Startup Check ---
  // Triggers an initial fetch 5 seconds after boot if needed
  setTimeout(() => {
    logger.info('🚀 Startup: Triggering initial News Fetch check...');
    queueManager.addFetchJob(
        'fetch-feed-day', 
        { reason: 'startup' }, 
        'startup-init' 
    );
  }, 5000);
};
