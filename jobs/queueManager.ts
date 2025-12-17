// jobs/queueManager.ts
import { Queue, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';

// --- 1. Redis Connection Config ---
// CRITICAL FIX: Use the BullMQ-specific config, not the generic one
const connectionConfig = config.bullMQConnection;
const isRedisConfigured = !!connectionConfig;

if (!isRedisConfigured) {
    logger.warn("⚠️ REDIS_URL not set or invalid. Background jobs will be disabled.");
}

// --- 2. Initialize Queue (Producer) ---
let newsQueue: Queue | null = null;

if (isRedisConfigured && connectionConfig) {
    try {
        newsQueue = new Queue('news-fetch-queue', { 
            connection: connectionConfig as ConnectionOptions,
            defaultJobOptions: {
                removeOnComplete: 20, 
                removeOnFail: 50,     
                attempts: 3,           
                backoff: { type: 'exponential', delay: 5000 }
            }
        });
        logger.info("✅ Job Queue (Producer) Initialized");
    } catch (err: any) {
        logger.error(`❌ Failed to initialize Queue: ${err.message}`);
        newsQueue = null;
    }
}

const queueManager = {
    /**
     * Adds a single job to the queue.
     * @param name - The name of the job (e.g., 'fetch-feed')
     * @param data - Data to pass to the worker
     * @param jobId - (Optional) A unique ID. If a job with this ID already exists, this add will be ignored.
     */
    addFetchJob: async (name: string = 'manual-fetch', data: any = {}, jobId?: string) => {
        if (!newsQueue) return null;
        try {
            const opts: any = {};
            if (jobId) opts.jobId = jobId;
            
            return await newsQueue.add(name, data, opts);
        } catch (err: any) {
            logger.error(`❌ Failed to add job ${name}: ${err.message}`);
            return null;
        }
    },

    /**
     * Adds multiple jobs in bulk (Efficient)
     */
    addBulk: async (jobs: { name: string; data: any }[]) => {
        if (!newsQueue) return null;
        try {
            return await newsQueue.addBulk(jobs);
        } catch (err: any) {
            logger.error(`❌ Failed to add bulk jobs: ${err.message}`);
            return null;
        }
    },

    /**
     * Schedules a repeatable job (Cron-like)
     */
    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any = {}) => {
        if (!newsQueue) return null;
        try {
            // Remove existing repeatable jobs with the same key to update schedule
            const repeatableJobs = await newsQueue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);
            
            if (existing) {
                if (existing.pattern !== cronPattern) {
                    await newsQueue.removeRepeatableByKey(existing.key);
                    logger.info(`🔄 Updating schedule for: ${name}`);
                } else {
                    return existing;
                }
            }

            // Add new schedule
            const job = await newsQueue.add(name, data, { 
                repeat: { pattern: cronPattern },
                jobId: `cron-${name}` // Enforce consistent ID
            });
            
            logger.info(`⏰ Job Scheduled: ${name} (${cronPattern})`);
            return job;
        } catch (err: any) {
             logger.error(`❌ Failed to schedule job ${name}: ${err.message}`);
             return null;
        }
    },

    getStats: async () => {
        if (!newsQueue) return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'disabled' };
        try {
            const [waiting, active, completed, failed] = await Promise.all([
                newsQueue.getWaitingCount(),
                newsQueue.getActiveCount(),
                newsQueue.getCompletedCount(),
                newsQueue.getFailedCount()
            ]);
            return { waiting, active, completed, failed, status: 'active' };
        } catch (err) {
            return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'error' };
        }
    },

    shutdown: async () => {
        if (newsQueue) await newsQueue.close();
        logger.info('✅ Job Queue Producer shutdown complete.');
    }
};

export default queueManager;
