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
import { Queue } from 'bullmq'; // Added import
import { CONSTANTS } from './utils/constants'; // Added import
import config from './utils/config'; // Added import

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

    // 3. RECOVERY: Kickstart Stalled Jobs
    // If the previous container crashed, jobs might be stuck in "Active" state.
    // This forces them back to "Wait" or "Failed" so they can be picked up again.
    if (config.bullMQConnection) {
        try {
            const recoveryQueue = new Queue(CONSTANTS.QUEUE.NAME, { 
                connection: config.bullMQConnection 
            });
            // Clean jobs that have been stuck for > 5 minutes
            const cleaned = await recoveryQueue.clean(300000, 0, 'active'); 
            if (cleaned && cleaned.length > 0) {
                 logger.info(`🚑 Recovered ${cleaned.length} stalled jobs from previous crash.`);
            }
            await recoveryQueue.close();
        } catch (e) {
            logger.warn("⚠️ Job Recovery skipped (Redis connection issue).");
        }
    }

    // 4. Start the Scheduler (Cron Jobs)
    startScheduler();

    // 5. Initialize Queue Consumer
    startWorker();
    
    logger.info('🚀 Background Worker Fully Operational & Listening for Jobs');

    // 6. Register Graceful Shutdown
    registerShutdownHandler('Worker Service', [
        async () => { await queueManager.shutdown(); },
        async () => { await shutdownWorker(); },
        async () => { await dbLoader.disconnect(); }
    ]);

  } catch (err) {
    if (err instanceof Error) {
        logger.error(`❌ Worker Startup Failed: ${err.message}`);
    } else {
        logger.error('❌ Worker Startup Failed: Unknown error');
    }
    process.exit(1); 
  }
};

if (require.main === module) {
    initWorkerService();
}
