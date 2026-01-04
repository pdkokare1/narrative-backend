// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import { Queue } from 'bullmq';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// Define queues
// FIX: Use the central CONSTANTS name so the Worker can find these jobs.
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
  // Runs at :05 and :35 (every 30 mins, offset from main feed)
  safeSchedule('update-trending', '5,35 * * * *', async () => {
      await newsQueue.add('update-trending', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 3. Main Feed Fetch (Day Mode)
  // 6:00 AM to 11:00 PM -> Every 30 minutes (:15 and :45)
  // Provides fresh news throughout the active day.
  safeSchedule('fetch-feed-day', '15,45 6-22 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 4. Main Feed Fetch (Night Mode)
  // 11:00 PM to 6:00 AM -> Every 2 hours
  // Runs at 23:15, 01:15, 03:15, 05:15
  safeSchedule('fetch-feed-night', '15 23,1,3,5 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 5. Low Frequency: Morning/Night Briefings
  // Specific briefing generation at 8:10 AM and 8:10 PM
  safeSchedule('fetch-briefing-morning', '10 8 * * *', async () => {
      await newsQueue.add('fetch-feed-morning', {}, { removeOnComplete: true });
  });

  safeSchedule('fetch-briefing-night', '10 20 * * *', async () => {
      await newsQueue.add('fetch-feed-night', {}, { removeOnComplete: true });
  });

  // 6. Daily Maintenance: Cleanup
  // Runs at 00:45 AM
  safeSchedule('daily-cleanup', '45 0 * * *', async () => {
      await cleanupQueue.add('daily-cleanup', {}, { removeOnComplete: true });
  });

  logger.info('✅ Schedules registered: Trending(30m), Feed(Day:30m, Night:2h), Briefings(8:10/20:10)');
};
