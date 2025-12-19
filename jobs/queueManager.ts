// jobs/queueManager.ts
import { Queue, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// Registry to hold multiple queues
const queues: Record<string, Queue> = {};

// Use Centralized Name
const NEWS_QUEUE_NAME = CONSTANTS.QUEUE.NAME;

const queueManager = {
    /**
     * Initializes the Queues safely.
     * Should be called ONCE at server startup.
     */
    initialize: async () => {
        if (queues[NEWS_QUEUE_NAME]) return;

        // SAFE ACCESS: Use the strictly typed config from utils/config
        const connectionConfig = config.bullMQConnection || config.redisOptions;
        
        // Ensure we have a valid object, not just a string URL
        const isRedisConfigured = !!connectionConfig && typeof connectionConfig === 'object';

        if (!isRedisConfigured) {
            logger.warn("⚠️ REDIS_URL not set or invalid. Background jobs will be disabled.");
            return;
        }

        try {
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
                    // Suppress simple connection refused errors to avoid log spam
                    if (!err.message.includes('ECONNREFUSED')) {
                         logger.error(`❌ Queue [${name}] Connection Error: ${err.message}`);
                    }
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
        const queue = queues[queueName];
        if (!queue) {
            // Only log debug to avoid spamming production logs if redis is down
            logger.debug(`⚠️ Queue [${queueName}] not available. Job dropped.`);
            return null;
        }

        try {
            return await queue.add(jobName, data, opts);
        } catch (err: any) {
            logger.error(`❌ Failed to add job to [${queueName}]: ${err.message}`);
            return null;
        }
    },

    addFetchJob: async (name: string = 'fetch-feed', data: any = {}, jobId?: string) => {
        const opts = jobId ? { jobId } : {};
        return await queueManager.addJobToQueue(NEWS_QUEUE_NAME, name, data, opts);
    },

    addBulk: async (jobs: { name: string; data: any; opts?: any }[]) => {
        const queue = queues[NEWS_QUEUE_NAME];
        if (!queue) return null;
        try {
            return await queue.addBulk(jobs);
        } catch (err: any) {
            logger.error(`❌ Failed to add bulk jobs: ${err.message}`);
            return null;
        }
    },

    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any) => {
        if (!queues[NEWS_QUEUE_NAME]) await queueManager.initialize();
        const queue = queues[NEWS_QUEUE_NAME];

        if (!queue) return null;
        try {
            const repeatableJobs = await queue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);

            if (existing) {
                await queue.removeRepeatableByKey(existing.key);
            }

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
        logger.info('✅ All Job Queues closed.');
    }
};

export default queueManager;
