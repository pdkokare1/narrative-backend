// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';
import { 
    handleUpdateTrending, 
    handleFetchFeed, 
    handleProcessArticle 
} from './jobHandlers';

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
        // High concurrency for maximum throughput
        const concurrency = Math.max(config.worker.concurrency, 10);

        newsWorker = new Worker('news-fetch-queue', async (job: Job) => {
            
            switch (job.name) {
                case 'update-trending':
                    return await handleUpdateTrending(job);

                case 'fetch-feed':
                case 'scheduled-news-fetch':
                case 'manual-fetch':
                    return await handleFetchFeed(job);

                case 'process-article':
                    return await handleProcessArticle(job);

                default:
                    logger.warn(`⚠️ Unknown Job Type: ${job.name}`);
                    return null;
            }

        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            if (job.name !== 'process-article') { // Reduce noise for bulk jobs
                logger.info(`✅ Job ${job.id} (${job.name}) completed.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
        });

        logger.info(`✅ Background Worker Started (Concurrency: ${concurrency})`);

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
