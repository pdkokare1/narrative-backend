// jobs/queueManager.js
const { Queue, Worker } = require('bullmq');
const newsFetcher = require('./newsFetcher');
const logger = require('../utils/logger');

// --- 1. Redis Connection Config ---
// BullMQ needs a specific connection setup. We parse the REDIS_URL from Railway.
const redisUrl = process.env.REDIS_URL;
let connectionConfig;

if (redisUrl) {
    try {
        const url = new URL(redisUrl);
        connectionConfig = {
            host: url.hostname,
            port: Number(url.port),
            password: url.password,
            username: url.username,
            // BullMQ requires this specifically for stability
            maxRetriesPerRequest: null 
        };
        // Handle TLS (Railway Redis usually requires this if not on a private network)
        if (url.protocol === 'rediss:') {
            connectionConfig.tls = { rejectUnauthorized: false };
        }
    } catch (e) {
        logger.error(`❌ Invalid REDIS_URL: ${e.message}`);
    }
}

// --- 2. Define the Queue ---
const QUEUE_NAME = 'news-fetch-queue';
const newsQueue = new Queue(QUEUE_NAME, { 
    connection: connectionConfig,
    defaultJobOptions: {
        removeOnComplete: 100, // Keep last 100 logs
        removeOnFail: 500,     // Keep error logs for debugging
        attempts: 3,           // Retry 3 times if it fails
        backoff: {
            type: 'exponential',
            delay: 5000        // Wait 5s, then 10s, etc.
        }
    }
});

// --- 3. Define the Worker (The Processor) ---
const newsWorker = new Worker(QUEUE_NAME, async (job) => {
    logger.info(`👷 Worker started job: ${job.name} (ID: ${job.id})`);
    
    try {
        // Run the actual heavy lifting
        const result = await newsFetcher.run();
        
        if (!result) {
            // If run() returned false, it means it was already running or skipped
            return { status: 'skipped', reason: 'concurrent_execution' };
        }
        return { status: 'completed' };
    } catch (err) {
        logger.error(`❌ Worker Job Failed: ${err.message}`);
        throw err; // Throwing triggers the BullMQ retry logic
    }
}, { 
    connection: connectionConfig,
    concurrency: 1 // Only run 1 fetch job at a time to prevent rate limits
});

// --- 4. Event Listeners (Monitoring) ---
newsWorker.on('completed', (job) => {
    logger.info(`✅ Job ${job.id} completed successfully.`);
});

newsWorker.on('failed', (job, err) => {
    logger.error(`🔥 Job ${job.id} failed: ${err.message}`);
});

// --- 5. Public API ---
module.exports = {
    // Add a job to the queue
    addFetchJob: async (name = 'scheduled-fetch', data = {}) => {
        return await newsQueue.add(name, data);
    },
    
    // Get queue status (for admin dashboards)
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
