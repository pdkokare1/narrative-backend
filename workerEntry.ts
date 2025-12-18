// workerEntry.ts
import logger from './utils/logger';
import { startScheduler } from './jobs/scheduler';
import queueManager from './jobs/queueManager';
import dbLoader from './utils/dbLoader';
import { startWorker, shutdownWorker } from './jobs/worker';
import { registerShutdownHandler } from './utils/shutdownHandler';

// Imported Background Services
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService';

const initWorkerService = async () => {
  logger.info('🛠️ Starting Background Worker...');

  try {
    // 1. Unified Database & Redis Connection
    await dbLoader.connect();

    // 2. Initialize Background Logic (Fail Fast)
    // ✅ CHANGED: We use Promise.all to ensure that if Gatekeeper/Emergency fails, 
    // the worker restarts immediately rather than running in a broken state.
    await Promise.all([
        emergencyService.initializeEmergencyContacts(),
        gatekeeperService.initialize()
    ]);

    logger.info('✨ Background Services Initialized');

    // 3. Start the Scheduler (Cron Jobs)
    startScheduler();

    // 4. Initialize Queue Consumer
    startWorker();
    
    logger.info('🚀 Background Worker Fully Operational & Listening for Jobs');

    // 5. Register Graceful Shutdown
    registerShutdownHandler('Worker Service', [
        async () => { await queueManager.shutdown(); },
        async () => { await shutdownWorker(); }
    ]);

  } catch (err: any) {
    logger.error(`❌ Worker Startup Failed: ${err.message}`);
    process.exit(1); // Exit so Railway/Docker can restart it
  }
};

initWorkerService();
