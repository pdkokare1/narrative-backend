// jobs/worker.ts
import { Worker, Job, ConnectionOptions } from 'bullmq';
import path from 'path';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';

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

        // DYNAMIC PROCESSOR PATH
        // Detects if we are running as .ts (Dev) or .js (Prod)
        const extension = path.extname(__filename); 
        const processorFile = path.join(__dirname, `workerProcessor${extension}`);

        // @ts-ignore - ConnectionOptions typing
        newsWorker = new Worker(CONSTANTS.QUEUE.NAME, processorFile, { 
            connection: connectionConfig as ConnectionOptions,
            concurrency: concurrency,
            
            // CRITICAL: Lock Duration
            // Ensures Gemini has ample time (5 mins) for complex articles.
            lockDuration: 300000, 
            
            // Limit retries for stalled jobs
            maxStalledCount: 1, 
        });

        // --- Event Listeners ---
        newsWorker.on('completed', (job: Job) => {
            // Log only high-level jobs
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

        logger.info(`✅ Background Worker Started (Sandboxed, Queue: ${CONSTANTS.QUEUE.NAME}, Concurrency: ${concurrency})`);

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
