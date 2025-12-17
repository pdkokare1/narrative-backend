// jobs/queueManager.ts
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import logger from '../utils/logger';
import config from '../utils/config';

// --- 1. Redis Connection Config ---
const connectionConfig = config.redisOptions; 
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
            if (job.name === 'fetch-feed' || job.name === 'scheduled-news-fetch' || job.name === 'manual-fetch') {
                logger.info(`👷 Job: Fetching Feed...`);
                const articles = await newsFetcher.fetchFeed();

                if (articles.length > 0 && newsQueue) {
                    const jobs = articles.map(article => ({
                        name: 'process-article',
                        data: article,
                        opts: { 
                            removeOnComplete: true, 
                            attempts: 3 
                        }
                    }));

                    await newsQueue.addBulk(jobs);
                    logger.info(`✨ Dispatched ${articles.length} individual article jobs.`);
                }
                return { status: 'dispatched', count: articles.length };
            }

            // --- C. Article Processor ---
            if (job.name === 'process-article') {
                return await newsFetcher.processArticleJob(job.data);
            }

        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: Number(process.env.WORKER_CONCURRENCY) || 5, // Extracted to Env
            limiter: { max: 10, duration: 1000 } 
        });

        newsWorker.on('completed', (job: Job) => {
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

const queueManager = {
    /**
     * SMART ADD: Checks if a job is already waiting/active before adding.
     * Prevents "Startup Storms" where 3 replicas add 3 identical jobs.
     */
    addFetchJob: async (name: string = 'fetch-feed', data: any = {}) => {
        if (!newsQueue) return null;
        try {
            // Check concurrency: Is this job already running?
            const counts = await newsQueue.getJobCounts('active', 'waiting', 'delayed');
            
            // If the queue is busy with feed fetching (assuming it's the main task), 
            // skip adding another immediate fetch to prevent duplicates.
            // Note: This is a simple heuristic. For stricter locking, we'd check specific Job IDs.
            if (counts.active > 5 || counts.waiting > 10) {
                 logger.warn(`⚠️ Queue busy (Active: ${counts.active}, Waiting: ${counts.waiting}). Skipping ${name} request.`);
                 return null;
            }

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
                // If the Cron pattern changed, we remove the old one.
                if (existing.pattern !== cronPattern) {
                    await newsQueue.removeRepeatableByKey(existing.key);
                    logger.info(`🔄 Updating schedule for: ${name}`);
                } else {
                    // Schedule exists and is correct. Do nothing.
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
