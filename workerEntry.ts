// workerEntry.ts
import mongoose from 'mongoose';
import config from './utils/config';
import logger from './utils/logger';
import { initRedis } from './utils/redisClient';
import queueManager from './jobs/queueManager';
import scheduler from './jobs/scheduler';

// This process handles BACKGROUND TASKS only (News Fetching, Analytics)
// It does NOT serve website traffic.

const startWorker = async () => {
    logger.info('🚀 Starting Narrative Background Worker...');

    try {
        // 1. Initialize Redis (Shared Connection)
        await initRedis();

        // 2. Connect to MongoDB
        if (config.mongoUri) {
            await mongoose.connect(config.mongoUri);
            logger.info('✅ MongoDB Connected (Worker)');
        } else {
            throw new Error("MongoDB URI missing in config");
        }

        // 3. Start the BullMQ Worker
        queueManager.startWorker();

        // 4. Initialize Scheduler (Cron Jobs)
        scheduler.init();
        
        logger.info('✅ Worker Service Fully Operational');

        // Graceful Shutdown
        const gracefulShutdown = async () => {
            logger.info('🛑 Worker received kill signal. Shutting down...');
            await queueManager.shutdown();
            await mongoose.connection.close(false);
            process.exit(0);
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

    } catch (err: any) {
        logger.error(`❌ Worker Startup Failed: ${err.message}`);
        process.exit(1);
    }
};

startWorker();
