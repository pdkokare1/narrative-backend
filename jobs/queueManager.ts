// jobs/queueManager.ts
import { Queue, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';

let newsQueue: Queue | null = null;

const queueManager = {
    /**
     * Initializes the Queue Connection safely.
     * Must be called before adding jobs.
     */
    initialize: async () => {
        if (newsQueue) return; // Already initialized

        const connectionConfig = config.bullMQConnection;
        const isRedisConfigured = !!connectionConfig;

        if (!isRedisConfigured) {
            logger.warn("⚠️ REDIS_URL not set. Background jobs will be disabled.");
            return;
        }

        try {
            newsQueue = new Queue('news-fetch-queue', {
                connection: connectionConfig as ConnectionOptions,
                defaultJobOptions: {
                    removeOnComplete: 20, // Keep last 20 completed jobs
                    removeOnFail: 50,     // Keep last 50 failed jobs for debugging
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 }
                }
            });
            logger.info("✅ Job Queue (Producer) Initialized");
        } catch (err: any) {
            logger.error(`❌ Failed to initialize Queue: ${err.message}`);
            newsQueue = null;
        }
    },

    /**
     * Adds a single job to the queue.
     */
    addFetchJob: async (name: string = 'fetch-feed', data: any = {}, jobId?: string) => {
        if (!newsQueue) {
            // Auto-initialize if forgotten, but warn
            // await queueManager.initialize(); 
            // Better to return null to avoid race conditions during shutdown
            return null; 
        }
        try {
            const opts = jobId ? { jobId } : {};
            return await newsQueue.add(name, data, opts);
        } catch (err: any) {
            logger.error(`❌ Failed to add job: ${err.message}`);
            return null;
        }
    },

    /**
     * Adds multiple jobs efficiently (Batching).
     */
    addBulk: async (jobs: { name: string; data: any; opts?: any }[]) => {
        if (!newsQueue) return null;
        try {
            return await newsQueue.addBulk(jobs);
        } catch (err: any) {
            logger.error(`❌ Failed to add bulk jobs: ${err.message}`);
            return null;
        }
    },

    /**
     * Schedules a recurring job using Cron syntax.
     */
    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any) => {
        if (!newsQueue) {
            logger.warn('⚠️ Queue not initialized, skipping schedule.');
            return null;
        }
        try {
            // Clean up old schedules for this key to avoid duplicates
            const repeatableJobs = await newsQueue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);

            if (existing) {
                await newsQueue.removeRepeatableByKey(existing.key);
                logger.debug(`🔄 Updated schedule for: ${name}`);
            }

            // Add new schedule
            const job = await newsQueue.add(name, data, {
                repeat: { pattern: cronPattern }
            });

            logger.info(`⏰ Job Scheduled: ${name} (${cronPattern})`);
            return job;
        } catch (err: any) {
            logger.error(`❌ Failed to schedule job ${name}: ${err.message}`);
            return null;
        }
    },

    /**
     * Get queue health statistics.
     */
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

    /**
     * Gracefully close the queue connection.
     */
    shutdown: async () => {
        if (newsQueue) {
            logger.info('🛑 Shutting down Job Queue (Producer)...');
            try {
                await newsQueue.close();
                logger.info('✅ Job Queue closed.');
                newsQueue = null;
            } catch (err: any) {
                logger.error(`⚠️ Error during Queue shutdown: ${err.message}`);
            }
        }
    }
};

export default queueManager;
