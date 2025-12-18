// workerEntry.ts
import config from './utils/config';
import logger from './utils/logger';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';
import dbLoader from './utils/dbLoader';
import { startWorker } from './jobs/worker';

// Imported Background Services
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService';

const initWorkerService = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Unified Database & Redis Connection
    await dbLoader.connect();

    // 2. Initialize Background Logic 
    // We use Promise.allSettled to ensure one failure doesn't stop the whole worker
    const results = await Promise.allSettled([
        emergencyService.initializeEmergencyContacts(),
        gatekeeperService.initialize()
    ]);

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            logger.error(`⚠️ Background Service ${index} failed to init: ${result.reason}`);
        }
    });

    logger.info('✨ Background Services Initialized');

    // 3. Start the Scheduler (Cron Jobs)
    startScheduler();

    // 4. Initialize Queue Consumer
    startWorker();
    
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
    await dbLoader.disconnect(); 
    logger.info('✅ Worker resources released.');
    process.exit(0);
  } catch (err: any) {
    logger.error(`⚠️ Error during worker shutdown: ${err.message}`);
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initWorkerService();
