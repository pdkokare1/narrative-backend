// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';
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
        // Safe Concurrency Default
        const concurrency = config.worker.concurrency || 1;

        // @ts-ignore - ConnectionOptions typing
        newsWorker = new Worker(CONSTANTS.QUEUE.NAME, async (job: Job) => {
            
            switch (job.name) {
                case 'update-trending':
                    return await handleUpdateTrending(job);

                case 'fetch-feed':
                case 'scheduled-news-fetch':
                case 'manual-fetch':
                    return await handleFetchFeed(job);

                case 'process-article':
                    // We can optionally extend the lock periodically here if needed in the future
                    return await handleProcessArticle(job);

                default:
                    logger.warn(`⚠️ Unknown Job Type: ${job.name}`);
                    return null;
            }

        }, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            
            // CRITICAL CHANGE: Increased to 5 Minutes (300,000ms)
            // This ensures Gemini has ample time to think for complex articles without the job timing out.
            lockDuration: 300000, 
            
            // Limit how many times a "stalled" job is retried to prevent infinite loops
            maxStalledCount: 1, 
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            // Only log high-level jobs to avoid spamming logs with 100s of "process-article"
            if (job.name !== 'process-article') { 
                logger.info(`✅ Job ${job.id} (${job.name}) completed.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
            
            // DEAD LETTER ALERT: If a job has failed all its attempts
            if (job && job.attemptsMade >= (job.opts.attempts || 0)) {
                logger.error(`🚨 DEAD LETTER: Job ${job.id} has permanently failed after ${job.attemptsMade} attempts.`);
            }
        });
        
        newsWorker.on('error', (err) => {
             // Worker connection errors
             logger.error(`⚠️ Worker Connection Error: ${err.message}`);
        });

        logger.info(`✅ Background Worker Started (Queue: ${CONSTANTS.QUEUE.NAME}, Concurrency: ${concurrency}, Lock: 5mins)`);

    } catch (err: any) {
        logger.error(`❌ Failed to start Worker: ${err.message}`);
    }
};

export const shutdownWorker = async () => {
    if (newsWorker) {
        logger.info('🛑 Shutting down Worker...');
        try {
            await newsWorker.close();
            logger.info('✅ Worker shutdown complete.');
        } catch (err: any) {
            logger.error(`⚠️ Error shutting down worker: ${err.message}`);
        }
    }
};
