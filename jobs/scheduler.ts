// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import queueManager from './queueManager';

export const startScheduler = () => {
  logger.info('⏰ Scheduler Initialized');

  // --- 1. News Fetch Job (Every 2 Hours) ---
  // Cron Expression: "0 */2 * * *" means "At minute 0 past every 2nd hour"
  cron.schedule('0 */2 * * *', async () => {
    logger.info('⏰ Cron Trigger: Scheduling News Fetch');
    await queueManager.addFetchJob();
  });

  // --- 2. Cleanup Old Data (Daily at Midnight) ---
  cron.schedule('0 0 * * *', async () => {
    logger.info('⏰ Cron Trigger: Scheduling System Cleanup');
    // You can add a cleanup job to the queue here in the future
  });

  // --- Run Immediately on Startup (Optional but recommended for testing) ---
  // This ensures that whenever you deploy, you get fresh news immediately.
  setTimeout(() => {
    logger.info('🚀 Startup: Triggering initial News Fetch...');
    queueManager.addFetchJob();
  }, 5000); // Wait 5s for connections to settle
};
