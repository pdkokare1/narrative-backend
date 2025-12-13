// jobs/queueManager.ts
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import logger from '../utils/logger';

// --- 1. Redis Connection Config ---
const redisUrl = process.env.REDIS_URL;
let connectionConfig: ConnectionOptions | undefined;

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
        if (url.protocol === 'rediss:') {
            connectionConfig.tls = { rejectUnauthorized: false };
        }
    } catch (e: any) {
        logger.error(`❌ Invalid REDIS_URL: ${e.message}`);
    }
}

// --- 2. Define the Queue ---
const QUEUE_NAME = 'news-fetch-queue';
const newsQueue = new Queue(QUEUE_NAME, { 
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

// --- 3. Define the Worker ---
const newsWorker = new Worker(QUEUE_NAME, async (job: Job) => {
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

// --- 4. Event Listeners ---
newsWorker.on('completed', (job: Job) => {
    logger.info(`✅ Job ${job.id} completed successfully.`);
});

newsWorker.on('failed', (job: Job | undefined, err: Error) => {
    if (job) {
        logger.error(`🔥 Job ${job.id} failed: ${err.message}`);
    } else {
        logger.error(`🔥 Job failed (no ID): ${err.message}`);
    }
});

// --- 5. Export ---
const queueManager = {
    addFetchJob: async (name: string = 'scheduled-fetch', data: any = {}) => {
        return await newsQueue.add(name, data);
    },
    
    getStats: async () => {
        const [waiting, active, completed, failed] = await Promise.all([
            newsQueue.getWaitingCount(),
            newsQueue.getActiveCount(),
            newsQueue.getCompletedCount(),
            newsQueue.getFailedCount()
        ]);
        return { waiting, active, completed, failed };
    }
};

export default queueManager;
