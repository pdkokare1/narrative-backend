// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

// DIRECT IMPORT for Monolithic/Threaded mode
// This saves memory by NOT spawning a separate process per job.
// Critical for Railway deployments with limited RAM (512MB/1GB).
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
        const concurrency = config.worker.concurrency || 1;

        // OPTIMIZATION: Use Function Processor (Threaded) instead of File Path (Sandboxed)
        // This keeps everything in one process, saving ~100MB RAM per concurrency slot.
        // @ts-ignore
        newsWorker = new Worker(CONSTANTS.QUEUE.NAME, workerProcessor, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            
            // Lock Duration: 5 mins for complex AI tasks
            lockDuration: 300000, 
            
            // Retries
            maxStalledCount: 1, 
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            if (job.name !== 'process-article') { 
                logger.info(`✅ Job ${job.id} (${job.name}) completed.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
            if (job && job.attemptsMade >= (job.opts.attempts || 0)) {
                logger.error(`🚨 DEAD LETTER: Job ${job.id} has permanently failed.`);
            }
        });
        
        newsWorker.on('error', (err) => {
             logger.error(`⚠️ Worker Connection Error: ${err.message}`);
        });

        logger.info(`✅ Background Worker Started (Threaded Mode, Queue: ${CONSTANTS.QUEUE.NAME}, Concurrency: ${concurrency})`);

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
