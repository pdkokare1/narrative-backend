// workerEntry.ts
import mongoose from 'mongoose';
import * as admin from 'firebase-admin';
import http from 'http'; // Import http module

// Config & Utils
import config from './utils/config';
import logger from './utils/logger';
import redisClient from './utils/redisClient';
import dbLoader from './utils/dbLoader';

// Jobs
import { startWorker, shutdownWorker } from './jobs/worker';
import { startScheduler } from './jobs/scheduler';

// --- 1. Start Health Check Server IMMEDIATELY ---
// This ensures Railway deployment passes even if DB takes time to connect
const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('Worker Running');
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(port, () => {
    logger.info(`🏥 Worker Health Check Server listening on port ${port}`);
});

// --- 2. Firebase Init ---
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

// --- 3. Start Background Services ---
const startBackgroundService = async () => {
    try {
        logger.info('👷 Starting Background Worker Process...');

        // Connect to Database & Redis
        await dbLoader.connect();

        // Start the Job Processor (Consumer)
        startWorker();

        // Start the Scheduler (Producer)
        await startScheduler();

        logger.info('✅ Worker & Scheduler are fully operational.');

    } catch (err: any) {
        logger.error(`❌ Critical Worker Startup Error: ${err.message}`);
        // We exit here because if the DB fails, the worker is useless. 
        // Railway will restart the process.
        process.exit(1);
    }
};

startBackgroundService();

// --- Graceful Shutdown ---
const gracefulShutdown = async () => {
    logger.info('🛑 Worker received Kill Signal...');
    
    const forceExit = setTimeout(() => {
        logger.error('🛑 Force Shutdown (Timeout)');
        process.exit(1);
    }, 10000);

    try {
        // Close HTTP server first
        server.close();
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
