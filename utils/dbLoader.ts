// utils/dbLoader.ts
import mongoose from 'mongoose';
import config from './config';
import logger from './logger';
import { initRedis, default as redisClient } from './redisClient';

/**
 * Centralized Database Loader
 * Handles connections for both MongoDB and Redis.
 * Used by both the API Server and the Background Worker.
 */
class DbLoader {
    private isConnected: boolean = false;

    public async connect(): Promise<void> {
        if (this.isConnected) {
            logger.info("ℹ️ Database connections already active.");
            return;
        }

        try {
            logger.info('🚀 Initializing Infrastructure...');

            // 1. Connect MongoDB
            if (!config.mongoUri) {
                throw new Error("❌ MongoDB URI missing in config");
            }
            
            // Handle connection events for better debugging
            mongoose.connection.on('error', (err) => logger.error(`🔥 MongoDB Error: ${err.message}`));
            mongoose.connection.on('disconnected', () => logger.warn('⚠️ MongoDB Disconnected'));

            await mongoose.connect(config.mongoUri);
            logger.info('✅ MongoDB Connected');

            // 2. Initialize Redis
            await initRedis();

            this.isConnected = true;
            logger.info('✨ Infrastructure Ready');

        } catch (err: any) {
            logger.error(`❌ Critical Infrastructure Failure: ${err.message}`);
            // If the DB fails to start, the app is useless. Crash and let Railway restart it.
            process.exit(1);
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.isConnected) return;
        
        try {
            logger.info('🛑 Closing Infrastructure connections...');
            await redisClient.quit();
            await mongoose.connection.close(false);
            this.isConnected = false;
            logger.info('✅ Infrastructure closed gracefully.');
        } catch (err: any) {
            logger.error(`⚠️ Error during disconnect: ${err.message}`);
        }
    }
}

export default new DbLoader();
