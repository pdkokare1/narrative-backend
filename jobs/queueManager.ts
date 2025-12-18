// jobs/queueManager.ts
import { Queue, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';

// Registry to hold multiple queues (e.g., 'news', 'email', 'notifications')
const queues: Record<string, Queue> = {};

// Constant for the main news queue to ensure consistency
const NEWS_QUEUE_NAME = 'news-fetch-queue';

const queueManager = {
    /**
     * Initializes the Queues safely.
     * Now capable of initializing multiple queues if needed.
     */
    initialize: async () => {
        // If already initialized, skip
        if (queues[NEWS_QUEUE_NAME]) return;

        const connectionConfig = config.bullMQConnection;
        const isRedisConfigured = !!connectionConfig;

        if (!isRedisConfigured) {
            logger.warn("⚠️ REDIS_URL not set. Background jobs will be disabled.");
            return;
        }

        try {
            // Helper to create a standardized queue
            const createQueue = (name: string) => {
                const q = new Queue(name, {
                    connection: connectionConfig as ConnectionOptions,
                    defaultJobOptions: {
                        removeOnComplete: 20, 
                        removeOnFail: 50,     
                        attempts: 3,          
                        backoff: { type: 'exponential', delay: 5000 }
                    }
                });
                
                q.on('error', (err) => {
                    logger.error(`❌ Queue [${name}] Connection Error: ${err.message}`);
                });
                return q;
            };

            // Initialize the primary News Queue
            queues[NEWS_QUEUE_NAME] = createQueue(NEWS_QUEUE_NAME);

            logger.info(`✅ Job Queues Initialized: [${Object.keys(queues).join(', ')}]`);
        } catch (err: any) {
            logger.error(`❌ Failed to initialize Queues: ${err.message}`);
        }
    },

    /**
     * Generic wrapper to add a job to any registered queue
     */
    addJobToQueue: async (queueName: string, jobName: string, data: any, opts: any = {}) => {
        // Self-healing: Ensure init
        if (!queues[queueName]) {
            await queueManager.initialize();
        }
        
        const queue = queues[queueName];
        if (!queue) {
            logger.error(`❌ Queue [${queueName}] not available. Job dropped.`);
            return null;
        }

        try {
            return await queue.add(jobName, data, opts);
        } catch (err: any) {
            logger.error(`❌ Failed to add job to [${queueName}]: ${err.message}`);
            return null;
        }
    },

    /**
     * Legacy wrapper: Adds a single job to the news queue.
     * Kept for backward compatibility with existing controllers.
     */
    addFetchJob: async (name: string = 'fetch-feed', data: any = {}, jobId?: string) => {
        const opts = jobId ? { jobId } : {};
        return await queueManager.addJobToQueue(NEWS_QUEUE_NAME, name, data, opts);
    },

    /**
     * Adds multiple jobs efficiently (Batching).
     * Defaults to News Queue.
     */
    addBulk: async (jobs: { name: string; data: any; opts?: any }[]) => {
        if (!queues[NEWS_QUEUE_NAME]) await queueManager.initialize();
        const queue = queues[NEWS_QUEUE_NAME];
        
        if (!queue) return null;
        try {
            return await queue.addBulk(jobs);
        } catch (err: any) {
            logger.error(`❌ Failed to add bulk jobs: ${err.message}`);
            return null;
        }
    },

    /**
     * Schedules a recurring job using Cron syntax.
     */
    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any) => {
        if (!queues[NEWS_QUEUE_NAME]) await queueManager.initialize();
        const queue = queues[NEWS_QUEUE_NAME];

        if (!queue) {
            logger.warn('⚠️ Queue not initialized, skipping schedule.');
            return null;
        }
        try {
            // 1. Clean up old schedules
            const repeatableJobs = await queue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);

            if (existing) {
                await queue.removeRepeatableByKey(existing.key);
                logger.debug(`🔄 Updated schedule for: ${name}`);
            }

            // 2. Add new schedule
            const job = await queue.add(name, data, {
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
        const queue = queues[NEWS_QUEUE_NAME];
        if (!queue) return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'disabled' };
        try {
            const [waiting, active, completed, failed] = await Promise.all([
                queue.getWaitingCount(),
                queue.getActiveCount(),
                queue.getCompletedCount(),
                queue.getFailedCount()
            ]);
            return { waiting, active, completed, failed, status: 'active' };
        } catch (err) {
            return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'error' };
        }
    },

    /**
     * Gracefully close all queue connections.
     */
    shutdown: async () => {
        logger.info('🛑 Shutting down Job Queues...');
        const promises = Object.values(queues).map(async (queue) => {
            try {
                await queue.close();
            } catch (err: any) {
                logger.warn(`⚠️ Error closing queue: ${err.message}`);
            }
        });
        
        await Promise.all(promises);
        // Clear registry
        for (const key in queues) delete queues[key];
        
        logger.info('✅ All Job Queues closed.');
    }
};

export default queueManager;
