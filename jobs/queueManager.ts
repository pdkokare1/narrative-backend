// jobs/queueManager.ts
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import logger from '../utils/logger';

// --- 1. Redis Connection Config ---
const redisUrl = process.env.REDIS_URL;
let connectionConfig: ConnectionOptions | undefined;
let isRedisConfigured = false;

if (redisUrl) {
    try {
        const url = new URL(redisUrl);
        connectionConfig = {
            host: url.hostname,
            port: Number(url.port),
            password: url.password,
            username: url.username,
            maxRetriesPerRequest: null 
        };
        // Handle rediss:// protocol
        if (url.protocol === 'rediss:') {
            connectionConfig.tls = { rejectUnauthorized: false };
        }
        isRedisConfigured = true;
    } catch (e: any) {
        logger.error(`❌ Invalid REDIS_URL: ${e.message}`);
    }
} else {
    logger.warn("⚠️ REDIS_URL not set. Background jobs will be disabled.");
}

// --- 2. Initialize Queue & Worker Safely ---
let newsQueue: Queue | null = null;
let newsWorker: Worker | null = null;

if (isRedisConfigured && connectionConfig) {
    try {
        newsQueue = new Queue('news-fetch-queue', { 
            connection: connectionConfig,
            defaultJobOptions: {
                removeOnComplete: 100, 
                removeOnFail: 500,     
                attempts: 3,           
                backoff: {
                    type: 'exponential',
                    delay: 5000        
                }
            }
        });

        newsWorker = new Worker('news-fetch-queue', async (job: Job) => {
            logger.info(`👷 Worker started job: ${job.name} (ID: ${job.id})`);
            
            try {
                // --- JOB ROUTING ---
                
                // Case A: Update Trending Topics
                if (job.name === 'update-trending') {
                    logger.info('📈 Worker executing: Update Trending Topics');
                    await statsService.updateTrendingTopics();
                    return { status: 'completed' };
                }

                // Case B: News Fetcher (Default)
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
            connection: connectionConfig,
            concurrency: 1, // Global Lock: Only 1 job runs at a time per worker instance
            limiter: {
                max: 1,
                duration: 1500
            }
        });

        // Event Listeners
        newsWorker.on('completed', (job: Job) => {
            logger.info(`✅ Job ${job.id} (${job.name}) completed successfully.`);
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} failed: ${err.message}`);
        });

        logger.info("✅ Job Queue Initialized with Rate Limiting");

    } catch (err: any) {
        logger.error(`❌ Failed to initialize Queue: ${err.message}`);
        newsQueue = null;
        newsWorker = null;
    }
}

// --- 3. Safe Export ---
const queueManager = {
    // Basic Add
    addFetchJob: async (name: string = 'manual-fetch', data: any = {}) => {
        if (!newsQueue) {
            logger.warn("⚠️ Cannot add job: Redis unavailable.");
            return null;
        }
        try {
            return await newsQueue.add(name, data);
        } catch (err: any) {
            logger.error(`❌ Failed to add job: ${err.message}`);
            return null;
        }
    },
    
    // NEW: Smart Schedule Handler
    scheduleRepeatableJob: async (name: string, cronPattern: string, data: any) => {
        if (!newsQueue) return null;
        try {
            // 1. Clean up old schedules for this job name to prevent duplicates/conflicts
            const repeatableJobs = await newsQueue.getRepeatableJobs();
            const existing = repeatableJobs.find(j => j.name === name);
            
            if (existing) {
                // If the schedule exists, we remove it to ensure we apply the latest Cron pattern
                await newsQueue.removeRepeatableByKey(existing.key);
            }

            // 2. Add the fresh schedule
            const job = await newsQueue.add(name, data, {
                repeat: { pattern: cronPattern }
            });
            
            return job;
        } catch (err: any) {
             logger.error(`❌ Failed to schedule job ${name}: ${err.message}`);
             return null;
        }
    },

    getStats: async () => {
        if (!newsQueue) {
            return { waiting: 0, active: 0, completed: 0, failed: 0, status: 'disabled' };
        }
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
    }
};

export default queueManager;
