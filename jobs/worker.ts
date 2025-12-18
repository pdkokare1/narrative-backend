// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import newsFetcher from './newsFetcher';
import statsService from '../services/statsService';
import queueManager from './queueManager';
import logger from '../utils/logger';
import config from '../utils/config';

const connectionConfig = config.bullMQConnection;
const isRedisConfigured = !!connectionConfig;

let newsWorker: Worker | null = null;

export const startWorker = () => {
    if (!isRedisConfigured || !connectionConfig) {
        logger.error("❌ Cannot start worker: Redis not configured.");
        return;
    }
    if (newsWorker) {
        logger.warn("⚠️ Worker already running.");
        return;
    }

    try {
        // We increase concurrency to take advantage of Pipeline Batching
        const concurrency = Math.max(config.worker.concurrency, 10);

        newsWorker = new Worker('news-fetch-queue', async (job: Job) => {
            
            if (job.name === 'update-trending') {
                logger.info(`👷 Job: Updating Trending Topics...`);
                await statsService.updateTrendingTopics();
                return { status: 'completed' };
            }

            if (job.name === 'fetch-feed' || job.name === 'scheduled-news-fetch' || job.name === 'manual-fetch') {
                logger.info(`👷 Job: Fetching Feed...`);
                const articles = await newsFetcher.fetchFeed();

                if (articles.length > 0) {
                    const jobs = articles.map(article => ({
                        name: 'process-article',
                        data: article,
                        opts: { 
                            removeOnComplete: true,
                            attempts: 3 
                        }
                    }));

                    await queueManager.addBulk(jobs);
                    logger.info(`✨ Dispatched ${articles.length} individual article jobs to Batch Engine.`);
                }
                return { status: 'dispatched', count: articles.length };
            }

            if (job.name === 'process-article') {
                // This calls pipelineService which now handles batching automatically
                return await newsFetcher.processArticleJob(job.data);
            }

        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            // Limiter removed to allow batching engine to saturate
            // We now rely on the Pipeline internal timer for safety
        });

        newsWorker.on('completed', (job: Job) => {
            if (job.name === 'fetch-feed' || job.name === 'update-trending') {
                logger.info(`✅ Job ${job.id} (${job.name}) completed successfully.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
        });

        logger.info(`✅ Background Worker Started (Batch Mode: Active, Concurrency: ${concurrency})`);

    } catch (err: any) {
        logger.error(`❌ Failed to start Worker: ${err.message}`);
    }
};

export const shutdownWorker = async () => {
    if (newsWorker) {
        logger.info('🛑 Shutting down Worker...');
        await newsWorker.close();
        logger.info('✅ Worker shutdown complete.');
    }
};
