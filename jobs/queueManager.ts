// jobs/queueManager.ts
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import logger from '../utils/logger';
import redisClient from '../utils/redisClient';

// --- 1. Redis Connection Config ---
const connectionConfig = redisClient.parseRedisConfig();
const isRedisConfigured = !!connectionConfig;

if (!isRedisConfigured) {
    logger.warn("⚠️ REDIS_URL not set or invalid. Background jobs will be disabled.");
}

// --- 2. Initialize Queue (Producer) ---
let newsQueue: Queue | null = null;
let newsWorker: Worker | null = null;

if (isRedisConfigured && connectionConfig) {
    try {
        newsQueue = new Queue('news-fetch-queue', { 
            connection: connectionConfig as ConnectionOptions,
            defaultJobOptions: {
                // COST OPTIMIZATION: Keep fewer jobs in history to save Redis RAM
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

// --- 3. Worker Starter (Consumer) ---
const startWorker = () => {
    if (!isRedisConfigured || !connectionConfig) {
        logger.error("❌ Cannot start worker: Redis not configured.");
        return;
    }
    if (newsWorker) return; 

    try {
        newsWorker = new Worker('news-fetch-queue', async (job: Job) => {
            logger.info(`👷 Worker started job: ${job.name} (ID: ${job.id})`);
            
            try {
                if (job.name === 'update-trending') {
                    await statsService.updateTrendingTopics();
                    return { status: 'completed' };
                }

                // Default: News Fetch
                const result = await newsFetcher.run();
                if (!result) {
                    return { status: 'skipped', reason: 'concurrent_execution' };
                }
                return { status: 'completed' };

            } catch (err: any) {
                logger.error(`❌ Worker Job Failed: ${err.message}`);
                throw err; 
            }
        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: 5, 
            limiter: { max: 5, duration: 1500 } 
        });

        newsWorker.on('completed', (job: Job) => {
            if (job.name !== 'update-trending') {
                logger.info(`✅ Job ${job.id} (${job.name}) completed successfully.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} failed: ${err.message}`);
        });

        logger.info("✅ Background Worker Started & Listening...");
    } catch (err: any) {
        logger.error(`❌ Failed to start Worker: ${err.message}`);
    }
};

// --- 4. Export ---
const queueManager = {
    addFetchJob: async (name: string = 'manual-fetch', data: any = {}) => {
        if (!newsQueue) return null;
        try {
            return await newsQueue.add(name, data);
        } catch (err: any) {
            logger.error(`❌ Failed to add job: ${err.message}`);
            return null;
        }
    },
    
    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any) => {
        if (!newsQueue) return null;
        try {
            const repeatableJobs = await newsQueue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);
            if (existing) {
                await newsQueue.removeRepeatableByKey(existing.key);
            }
            return await newsQueue.add(name, data, { repeat: { pattern: cronPattern } });
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

    startWorker, 

    shutdown: async () => {
        logger.info('🛑 Shutting down Job Queue & Workers...');
        try {
            if (newsWorker) await newsWorker.close();
            if (newsQueue) await newsQueue.close();
            logger.info('✅ Job Queue shutdown complete.');
        } catch (err: any) {
            logger.error(`⚠️ Error during Queue shutdown: ${err.message}`);
        }
    }
};

export default queueManager;
