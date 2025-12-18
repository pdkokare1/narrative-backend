// workerEntry.ts
import config from './utils/config';
import logger from './utils/logger';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';
import dbLoader from './utils/dbLoader';
import { startWorker } from './jobs/worker'; // FIX: Import from actual worker file

// Imported Background Services
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService';

const initWorkerService = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Unified Database & Redis Connection
    await dbLoader.connect();

    // 2. Initialize Background Logic 
    await Promise.all([
        emergencyService.initializeEmergencyContacts(),
        gatekeeperService.initialize()
    ]);
    logger.info('✨ Background Services Initialized');

    // 3. Start the Scheduler (Cron Jobs)
    startScheduler();

    // 4. Initialize Queue Consumer
    startWorker(); // FIX: Call the imported function directly
    
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
