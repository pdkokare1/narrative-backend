// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import { Queue } from 'bullmq';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// Define queues
const newsQueue = new Queue('news-queue', {
  connection: config.redis
});

const cleanupQueue = new Queue('cleanup-queue', {
  connection: config.redis
});

// Simple memory lock to prevent local overlap (in case cron fires faster than execution)
const jobLocks: Record<string, boolean> = {};

const safeSchedule = (name: string, cronExpression: string, task: () => Promise<void>) => {
    cron.schedule(cronExpression, async () => {
        if (jobLocks[name]) {
            logger.warn(`⚠️ Skipping ${name}: Previous run still active.`);
            return;
        }
        
        jobLocks[name] = true;
        try {
            logger.info(`⏰ Cron Trigger: ${name}`);
            await task();
        } catch (err: any) {
            logger.error(`❌ Cron ${name} Failed: ${err.message}`);
        } finally {
            jobLocks[name] = false;
        }
    });
};

export const initScheduler = () => {
  logger.info('⏰ Scheduler initialized...');

  // 1. High Frequency: Update Trending Topics (Every 30 mins at :00 and :30)
  // Keeps the dashboard fresh without heavy article fetching.
  safeSchedule('update-trending', '0,30 * * * *', async () => {
      await newsQueue.add('update-trending', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 2. Medium Frequency: Main Feed Fetch (Every 2 hours at :15 past the hour)
  // OFFSET by 15 mins to avoid conflict with trending updates.
  safeSchedule('fetch-feed', '15 */2 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 3. Low Frequency: Morning/Night Briefings (Specific Times)
  // Running at :05 to avoid the top-of-the-hour rush.
  safeSchedule('fetch-feed-morning', '5 8 * * *', async () => { // 8:05 AM
      await newsQueue.add('fetch-feed-morning', {}, { removeOnComplete: true });
  });

  safeSchedule('fetch-feed-night', '5 20 * * *', async () => { // 8:05 PM
      await newsQueue.add('fetch-feed-night', {}, { removeOnComplete: true });
  });

  // 4. Daily Maintenance: Cleanup (Midnight :45)
  // Way off-peak to ensure resources are free.
  safeSchedule('daily-cleanup', '45 0 * * *', async () => {
      await cleanupQueue.add('daily-cleanup', {}, { removeOnComplete: true });
  });

  logger.info('✅ Schedules registered: Trending(:00,:30), Feed(:15 bi-hourly), Briefings(8:05, 20:05)');
};
