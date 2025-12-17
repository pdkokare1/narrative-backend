// workerEntry.ts
import mongoose from 'mongoose';
import * as admin from 'firebase-admin';

// Config & Utils
import config from './utils/config';
import logger from './utils/logger';
import redisClient from './utils/redisClient';
import dbLoader from './utils/dbLoader';

// Jobs
import { startWorker, shutdownWorker } from './jobs/worker';
import { startScheduler } from './jobs/scheduler';

// --- Firebase Init (Needed for some background tasks) ---
try {
  if (config.firebase.serviceAccount) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(config.firebase.serviceAccount)
      });
      logger.info('🔥 Firebase Admin SDK Initialized (Worker)');
    }
  }
} catch (error: any) {
  logger.error(`Firebase Admin Init Error: ${error.message}`);
}

const startBackgroundService = async () => {
    try {
        logger.info('👷 Starting Background Worker Process...');

        // 1. Connect to Database & Redis
        await dbLoader.connect();

        // 2. Start the Job Processor (Consumer)
        startWorker();

        // 3. Start the Scheduler (Producer)
        // Checks if it needs to trigger new jobs
        await startScheduler();

        logger.info('✅ Worker & Scheduler are fully operational.');

        // --- Graceful Shutdown ---
        const gracefulShutdown = async () => {
            logger.info('🛑 Worker received Kill Signal...');
            
            const forceExit = setTimeout(() => {
                logger.error('🛑 Force Shutdown (Timeout)');
                process.exit(1);
            }, 10000);

            try {
                await shutdownWorker();
                await dbLoader.disconnect();
                clearTimeout(forceExit);
                logger.info('✅ Worker resources released. Exiting.');
                process.exit(0);
            } catch (err: any) {
                logger.error(`⚠️ Error during worker shutdown: ${err.message}`);
                process.exit(1);
            }
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

    } catch (err: any) {
        logger.error(`❌ Critical Worker Startup Error: ${err.message}`);
        process.exit(1);
    }
};

startBackgroundService();
