// workerEntry.ts
import config from './utils/config';
import logger from './utils/logger';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';
import dbLoader from './utils/dbLoader'; // Import new centralized loader

const startWorker = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Unified Database & Redis Connection
    await dbLoader.connect();

    // 2. Start the Scheduler (Cron Jobs)
    // This schedules the "fetch" commands
    startScheduler();

    // 3. Initialize Queue Consumer
    // CRITICAL FIX: We must explicitly start the worker to process the jobs!
    queueManager.startWorker();
    
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
    await queueManager.shutdown();
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
