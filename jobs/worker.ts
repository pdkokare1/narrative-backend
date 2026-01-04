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
        // FIX: Force Concurrency to 1 to prevent OOM (Out of Memory) crashes
        // Running 5 AI pipelines in parallel was killing the container.
        const concurrency = 1;

        // @ts-ignore
        newsWorker = new Worker(CONSTANTS.QUEUE.NAME, workerProcessor, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            
            // Lock Duration: 2 mins to recover faster if a worker crashes
            lockDuration: 120000, 
            
            // Retries: If the worker crashes, retry the job up to 3 times
            maxStalledCount: 3, 
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            if (job.name !== 'process-article') { 
                logger.info(`✅ Job ${job.id} (${job.name}) completed.`);
            }
        });

        newsWorker.on('failed', (job: Job | undefined, err: Error) => {
            // Log specifically to see WHY it failed
            logger.error(`🔥 Job ${job?.id || 'unknown'} (${job?.name}) failed: ${err.message}`);
        });
        
        newsWorker.on('error', (err) => {
             logger.error(`⚠️ Worker Connection Error: ${err.message}`);
        });

        newsWorker.on('ready', () => {
            logger.info("✅ Worker is READY and processing.");
        });

        logger.info(`✅ Background Worker Started (Queue: ${CONSTANTS.QUEUE.NAME}, Concurrency: ${concurrency})`);

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
