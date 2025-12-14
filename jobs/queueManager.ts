// jobs/queueManager.ts
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
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
                // Run the actual heavy lifting
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
            concurrency: 1 
        });

        // Event Listeners
        newsWorker.on('completed', (job: Job) => {
            logger.info(`✅ Job ${job.id} completed successfully.`);
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} failed: ${err.message}`);
        });

        logger.info("✅ Job Queue Initialized");

    } catch (err: any) {
        logger.error(`❌ Failed to initialize Queue: ${err.message}`);
        newsQueue = null;
        newsWorker = null;
    }
}

// --- 3. Safe Export ---
const queueManager = {
    addFetchJob: async (name: string = 'scheduled-fetch', data: any = {}) => {
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
