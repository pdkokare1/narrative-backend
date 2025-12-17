// workerEntry.ts
import config from './utils/config';
import logger from './utils/logger';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';
import { startWorker as startJobWorker, shutdownWorker } from './jobs/worker'; // Import from correct file
import dbLoader from './utils/dbLoader';

const startWorker = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Unified Database & Redis Connection
    await dbLoader.connect();

    // 2. Start the Scheduler (Cron Jobs)
    // This schedules the "fetch" commands
    startScheduler();

    // 3. Initialize Queue Consumer
    // CRITICAL FIX: explicit call to the worker starter imported from jobs/worker
    startJobWorker();
    
    logger.info('🚀 Background Worker Fully Operational & Listening for Jobs');

  } catch (err: any) {
    logger.error(`❌ Worker Startup Failed: ${err.message}`);
    process.exit(1);
  }
};

// Graceful Shutdown
const shutdown = async () => {
  logger.info('🛑 Worker stopping...');
  try {
    await shutdownWorker(); // Stop the consumer
    await queueManager.shutdown(); // Stop the producer
    await dbLoader.disconnect(); // Centralized disconnect
    logger.info('✅ Worker resources released.');
    process.exit(0);
  } catch (err: any) {
    logger.error(`⚠️ Error during worker shutdown: ${err.message}`);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startWorker();
