// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import { Queue } from 'bullmq';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// Define queues
// FIX: Use the central CONSTANTS name so the Worker can find these jobs.
// Previously this was 'news-queue' which caused a mismatch.
const newsQueue = new Queue(CONSTANTS.QUEUE.NAME, {
  connection: config.bullMQConnection
});

// FIX: Consolidating cleanup into the main queue since we have a single worker.
const cleanupQueue = new Queue(CONSTANTS.QUEUE.NAME, {
  connection: config.bullMQConnection
});

// Simple memory lock to prevent local overlap (in case cron fires faster than execution)
const jobLocks: Record<string, boolean> = {};

/**
 * Removes old/stale repeatable jobs that might be lingering in Redis
 * from previous deployments (e.g., 'cron-day', 'fetch-feed-day').
 */
const cleanupGhostJobs = async () => {
    try {
        const repeatableJobs = await newsQueue.getRepeatableJobs();
        
        // List of old job IDs or names seen in logs that we want to kill
        const ghostKeys = ['cron-day', 'fetch-feed-day', 'fetch-feed-morning', 'fetch-feed-night'];

        let cleanedCount = 0;
        for (const job of repeatableJobs) {
            // Check if the job name/key matches our ghost list
            // We look for partial matches because keys often contain timestamps/IDs
            const isGhost = ghostKeys.some(key => job.key.includes(key) || job.name === key);
            
            if (isGhost) {
                logger.warn(`👻 Removing Ghost Job from Redis: ${job.name} (Key: ${job.key})`);
                await newsQueue.removeRepeatableByKey(job.key);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            logger.info(`🧹 Cleaned up ${cleanedCount} ghost jobs.`);
        }
    } catch (error) {
        logger.error('⚠️ Failed to cleanup ghost jobs:', error);
    }
};

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

export const startScheduler = async () => {
  logger.info('⏰ Scheduler initializing...');

  // 1. CLEANUP FIRST: Kill the ghost jobs causing the crash
  await cleanupGhostJobs();

  // 2. High Frequency: Update Trending Topics
  // Changed from :00/:30 to :05/:35 to give breathing room after the hour
  safeSchedule('update-trending', '5,35 * * * *', async () => {
      await newsQueue.add('update-trending', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 3. Medium Frequency: Main Feed Fetch
  // Runs at :15 past the hour (every 2 hours)
  // No overlap with trending (which is at :05 and :35)
  safeSchedule('fetch-feed', '15 */2 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 4. Low Frequency: Morning/Night Briefings
  // Moved to :10 to avoid conflict with trending (:05) and feed (:15)
  safeSchedule('fetch-briefing-morning', '10 8 * * *', async () => { // 8:10 AM
      await newsQueue.add('fetch-feed-morning', {}, { removeOnComplete: true });
  });

  safeSchedule('fetch-briefing-night', '10 20 * * *', async () => { // 8:10 PM
      await newsQueue.add('fetch-feed-night', {}, { removeOnComplete: true });
  });

  // 5. Daily Maintenance: Cleanup
  // Moved to :45 to be far away from everything else
  safeSchedule('daily-cleanup', '45 0 * * *', async () => {
      await cleanupQueue.add('daily-cleanup', {}, { removeOnComplete: true });
  });

  logger.info('✅ Schedules registered: Trending(:05,:35), Feed(:15 bi-hourly), Briefings(8:10, 20:10)');
};
