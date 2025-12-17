// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import queueManager from './queueManager';
import logger from '../utils/logger';
import config from '../utils/config';

// Redis Config
const connectionConfig = config.redisOptions;
const isRedisConfigured = !!connectionConfig;

let newsWorker: Worker | null = null;

export const startWorker = () => {
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

                if (articles.length > 0) {
                    // Use queueManager to add child jobs
                    const jobs = articles.map(article => ({
                        name: 'process-article',
                        data: article,
                        opts: { 
                            removeOnComplete: true, 
                            attempts: 3 
                        }
                    }));

                    await queueManager.addBulk(jobs);
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
            concurrency: Number(process.env.WORKER_CONCURRENCY) || 5, 
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

export const shutdownWorker = async () => {
    if (newsWorker) {
        await newsWorker.close();
        logger.info('🛑 Worker shutdown complete.');
    }
};
