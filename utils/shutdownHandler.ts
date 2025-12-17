// utils/shutdownHandler.ts
import logger from './logger';
import dbLoader from './dbLoader';

type CleanupTask = () => Promise<void> | void;

/**
 * Registers process signal handlers for graceful shutdown.
 * @param serverName Name of the service (e.g., 'API Server', 'Worker') for logging.
 * @param cleanupTasks Array of async functions to run before disconnecting DB (e.g., closing HTTP server).
 */
export const registerShutdownHandler = (serverName: string, cleanupTasks: CleanupTask[]) => {
    const gracefulShutdown = async () => {
        logger.info(`🛑 ${serverName} received Kill Signal, shutting down gracefully...`);

        // Force exit if cleanup takes too long (10 seconds)
        const forceExit = setTimeout(() => {
            logger.error('🛑 Force Shutdown (Timeout)');
            process.exit(1);
        }, 10000);

        try {
            // 1. Run specific cleanup tasks (stop server, stop worker, etc)
            if (cleanupTasks.length > 0) {
                logger.info('⏳ Cleaning up resources...');
                for (const task of cleanupTasks) {
                    await task();
                }
            }

            // 2. Always disconnect DB and Redis last
            await dbLoader.disconnect();

            clearTimeout(forceExit);
            logger.info(`✅ ${serverName} resources released. Exiting.`);
            process.exit(0);
        } catch (err: any) {
            logger.error(`⚠️ Error during shutdown: ${err.message}`);
            process.exit(1);
        }
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
};
