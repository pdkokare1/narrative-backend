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
            
            // --- A. Maintenance Jobs ---
            if (job.name === 'update-trending') {
                logger.info(`👷 Job: Updating Trending Topics...`);
                await statsService.updateTrendingTopics();
                return { status: 'completed' };
            }

            // --- B. Feed Fetcher (The Fan-Out) ---
            // Handles 'fetch-feed' and legacy names for backward compatibility
            if (job.name === 'fetch-feed' || job.name === 'scheduled-news-fetch' || job.name === 'manual-fetch') {
                logger.info(`👷 Job: Fetching Feed...`);
                const articles = await newsFetcher.fetchFeed();

                if (articles.length > 0 && newsQueue) {
                    // Create a sub-job for EACH article (Fan-Out)
                    const jobs = articles.map(article => ({
                        name: 'process-article',
                        data: article,
                        opts: { 
                            removeOnComplete: true, // Don't clog Redis history
                            attempts: 3 
                        }
                    }));

                    await newsQueue.addBulk(jobs);
                    logger.info(`✨ Dispatched ${articles.length} individual article jobs.`);
                }
                return { status: 'dispatched', count: articles.length };
            }

            // --- C. Article Processor (High Concurrency) ---
            if (job.name === 'process-article') {
                return await newsFetcher.processArticleJob(job.data);
            }

        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: 5, // Process 5 articles at the same time!
            limiter: { max: 10, duration: 1000 } // Safety limit
        });

        newsWorker.on('completed', (job: Job) => {
            // Only log high-level jobs to avoid spamming logs with 50+ lines per batch
            if (job.name === 'fetch-feed' || job.name === 'update-trending') {
                logger.info(`✅ Job ${job.id} (${job.name}) completed successfully.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
        });

        logger.info("✅ Background Worker Started & Listening...");
    } catch (err: any) {
        logger.error(`❌ Failed to start Worker: ${err.message}`);
    }
};

// --- 4. Export ---
const queueManager = {
    /**
     * Adds a single, immediate job to the queue.
     */
    addFetchJob: async (name: string = 'fetch-feed', data: any = {}) => {
        if (!newsQueue) return null;
        try {
            return await newsQueue.add(name, data);
        } catch (err: any) {
            logger.error(`❌ Failed to add job: ${err.message}`);
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
            // Clean up old schedules
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

    // This was missing in the previous build, causing the error
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
