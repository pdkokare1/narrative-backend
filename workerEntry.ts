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
    startScheduler();

    // 4. Initialize Queue Workers (if they need specific startup logic)
    // Note: queueManager usually initializes automatically on import, 
    // but we log here to confirm it's active.
    logger.info('✅ Worker: Queue Manager Active');

    logger.info('🚀 Background Worker Fully Operational');

  } catch (err: any) {
    logger.error(`❌ Worker Startup Failed: ${err.message}`);
    process.exit(1);
  }
};

// Graceful Shutdown
const shutdown = async () => {
  logger.info('🛑 Worker stopping...');
  await queueManager.shutdown();
  await mongoose.connection.close(false);
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startWorker();
