// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import { Queue } from 'bullmq';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// Define queues
const newsQueue = new Queue(CONSTANTS.QUEUE.NAME, {
  connection: config.bullMQConnection
});

const cleanupQueue = new Queue(CONSTANTS.QUEUE.NAME, {
  connection: config.bullMQConnection
});

// Simple memory lock to prevent local overlap
const jobLocks: Record<string, boolean> = {};

/**
 * Removes old/stale repeatable jobs that might be lingering in Redis
 */
const cleanupGhostJobs = async () => {
    try {
        const repeatableJobs = await newsQueue.getRepeatableJobs();
        
        // Removed old 'morning/night' specific jobs as they are now unified
        const ghostKeys = ['cron-day', 'fetch-feed-day', 'fetch-feed-morning', 'fetch-feed-night'];

        let cleanedCount = 0;
        for (const job of repeatableJobs) {
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

  // 1. CLEANUP FIRST: Kill the ghost jobs
  await cleanupGhostJobs();

  // 2. High Frequency: Update Trending Topics
  // Runs at :05 and :35 (every 30 mins)
  safeSchedule('update-trending', '5,35 * * * *', async () => {
      await newsQueue.add('update-trending', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 3. Main Feed Fetch (Day Mode)
  // 6:00 AM to 11:00 PM -> Every 30 minutes (:15 and :45)
  safeSchedule('fetch-feed-day', '15,45 6-22 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 4. Main Feed Fetch (Night Mode)
  // 11:00 PM to 6:00 AM -> Every 2 hours
  safeSchedule('fetch-feed-night', '15 23,1,3,5 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 5. Briefings (Morning/Night)
  // FIXED: Changed job name from 'fetch-feed-morning' to 'fetch-feed' so the worker recognizes it.
  safeSchedule('fetch-briefing-morning', '10 8 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, { removeOnComplete: true });
  });

  safeSchedule('fetch-briefing-night', '10 20 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, { removeOnComplete: true });
  });

  // 6. Daily Maintenance: Cleanup
  safeSchedule('daily-cleanup', '45 0 * * *', async () => {
      await cleanupQueue.add('daily-cleanup', {}, { removeOnComplete: true });
  });

  logger.info('✅ Schedules registered: Trending(30m), Feed(Day:30m, Night:2h), Briefings(8:10/20:10)');
};
