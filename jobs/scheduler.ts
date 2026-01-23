// jobs/scheduler.ts
import cron from 'node-cron';
import logger from '../utils/logger';
import { Queue } from 'bullmq';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';
import axios from 'axios'; 
import Article from '../models/articleModel'; // Imported for Direct Cleanup

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
        
        const ghostKeys = [
            'cron-day', 
            'fetch-feed-day', 
            'fetch-feed-morning', 
            'fetch-feed-night',
            'fetch-feed',      
            'update-trending'
        ];

        let cleanedCount = 0;
        for (const job of repeatableJobs) {
            const isGhost = ghostKeys.some(key => job.key.includes(key) || job.name === key);
            
            if (isGhost) {
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

  // 1. CLEANUP FIRST
  await cleanupGhostJobs();

  // 2. KEEP-ALIVE (CRITICAL FIX)
  // Runs every 4 minutes to prevent Railway from sleeping (10m timeout)
  cron.schedule('*/4 * * * *', async () => {
      try {
          const targetUrl = process.env.APP_URL || 'https://www.google.com';
          await axios.get(targetUrl, { timeout: 5000 });
          logger.info(`💓 Heartbeat sent to ${targetUrl} (Keeps Worker Alive)`);
      } catch (err) {
          // Ignore errors, we just needed the outbound network traffic
          logger.debug('💓 Heartbeat pulse'); 
      }
  });

  // 3. High Frequency: Update Trending Topics (Every 30 mins)
  safeSchedule('update-trending', '5,35 * * * *', async () => {
      await newsQueue.add('update-trending', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 4. Main Feed Fetch (Day Mode)
  // 6:00 AM to 11:00 PM -> Every 45 minutes (Runs at :00 and :45)
  safeSchedule('fetch-feed-day', '*/45 6-22 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 5. Main Feed Fetch (Night Mode)
  // 11:00 PM to 6:00 AM -> Every 2 hours (23, 1, 3, 5)
  safeSchedule('fetch-feed-night', '0 23,1,3,5 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, {
          removeOnComplete: true,
          removeOnFail: 100
      });
  });

  // 6. Briefings
  safeSchedule('fetch-briefing-morning', '10 8 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, { removeOnComplete: true });
  });

  safeSchedule('fetch-briefing-night', '10 20 * * *', async () => {
      await newsQueue.add('fetch-feed', {}, { removeOnComplete: true });
  });

  // 7. Daily Cleanup & Trash Purge (Midnight)
  safeSchedule('daily-cleanup', '0 0 * * *', async () => {
      // A. Standard Cache Cleanup
      await cleanupQueue.add('daily-cleanup', {}, { removeOnComplete: true });

      // B. Empty Trash (Items archived > 30 days ago)
      try {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          
          const result = await Article.deleteMany({
              deletedAt: { $ne: null, $lt: thirtyDaysAgo }
          });
          
          if (result.deletedCount > 0) {
              logger.info(`🗑️ Trash Purge: Permanently deleted ${result.deletedCount} old articles.`);
          }
      } catch (err) {
          logger.error(`❌ Trash Purge Failed: ${err}`);
      }
  });

  logger.info('✅ Schedules registered: Heartbeat(4m), Trending(30m), Feed(45m/2h), TrashPurge(24h)');
};
