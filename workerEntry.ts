// workerEntry.ts
import mongoose from 'mongoose';
import config from './utils/config';
import logger from './utils/logger';
import { initRedis } from './utils/redisClient';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';

const startWorker = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Initialize Redis
    await initRedis();

    // 2. Connect to MongoDB
    if (config.mongoUri) {
      await mongoose.connect(config.mongoUri);
      logger.info('✅ Worker: MongoDB Connected');
    } else {
      throw new Error("MongoDB URI missing in config");
    }

    // 3. Start the Scheduler (Cron Jobs)
    // This schedules the "fetch" commands
    startScheduler();

    // 4. Initialize Queue Consumer
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
    await mongoose.connection.close(false);
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
