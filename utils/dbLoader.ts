// utils/dbLoader.ts
import mongoose from 'mongoose';
import config from './config';
import logger from './logger';
import { initRedis, default as redisClient } from './redisClient';

/**
 * Centralized Database Loader
 * Handles connections for both MongoDB and Redis.
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
            
            mongoose.connection.on('error', (err) => logger.error(`🔥 MongoDB Error: ${err.message}`));
            mongoose.connection.on('disconnected', () => logger.warn('⚠️ MongoDB Disconnected'));

            // SCALING IMPROVEMENT: Set maxPoolSize to prevent exhausting database connections
            await mongoose.connect(config.mongoUri, {
                maxPoolSize: 10, // Recommended for Serverless/Containerized environments
                serverSelectionTimeoutMS: 5000, // Fail fast if DB is down
                socketTimeoutMS: 45000, // Close idle sockets
            });
            
            logger.info('✅ MongoDB Connected');

            // 2. Initialize Redis
            await initRedis();

            this.isConnected = true;
            logger.info('✨ Infrastructure Ready');

        } catch (err: any) {
            logger.error(`❌ Critical Infrastructure Failure: ${err.message}`);
            process.exit(1);
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.isConnected) return;
        
        try {
            logger.info('🛑 Closing Infrastructure connections...');
            await redisClient.quit();
            await mongoose.disconnect(); // Updated from mongoose.connection.close(false) for cleaner shutdown
            this.isConnected = false;
            logger.info('✅ Infrastructure closed gracefully.');
        } catch (err: any) {
            logger.error(`⚠️ Error during disconnect: ${err.message}`);
        }
    }
}

export default new DbLoader();
