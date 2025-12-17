// workerEntry.ts
import mongoose from 'mongoose';
import http from 'http'; 

// Config & Utils
import config from './utils/config';
import logger from './utils/logger';
import redisClient from './utils/redisClient';
import dbLoader from './utils/dbLoader';
import { initFirebase } from './utils/firebaseInit';
import { registerShutdownHandler } from './utils/shutdownHandler';

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

// --- 2. Initialize Firebase (Centralized) ---
initFirebase();

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
        process.exit(1);
    }
};

startBackgroundService();

// --- Graceful Shutdown (Centralized) ---
registerShutdownHandler('Worker Service', [
    async () => {
        // Stop Health Server
        server.close();
        logger.info('Worker HTTP server closed.');
    },
    async () => {
        // Stop Job Processor
        await shutdownWorker();
    }
]);
