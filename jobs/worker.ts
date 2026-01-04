// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// DIRECT IMPORT for Monolithic/Threaded mode
import workerProcessor from './workerProcessor';

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
        // Force Concurrency to 1 for stability
        const concurrency = 1;

        // @ts-ignore
        newsWorker = new Worker(CONSTANTS.QUEUE.NAME, workerProcessor, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            
            // INCREASED: 5 Minutes Lock Duration
            // Critical for "Inline Batch Processing" where one job handles 5-10 articles
            lockDuration: 300000, 
            
            // Recovery settings
            maxStalledCount: 3, 
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            logger.info(`✅ Job ${job.id} (${job.name}) completed successfully.`);
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
        });
        
        newsWorker.on('error', (err) => {
             logger.error(`⚠️ Worker Connection Error: ${err.message}`);
        });

        newsWorker.on('ready', () => {
            logger.info("✅ Worker is READY and processing.");
        });

        logger.info(`✅ Background Worker Started (Queue: ${CONSTANTS.QUEUE.NAME}, Concurrency: ${concurrency}, Lock: 5m)`);

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
