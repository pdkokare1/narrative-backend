// utils/dbLoader.ts
import mongoose from 'mongoose';
import config from './config';
import logger from './logger';
import { initRedis, default as redisClient } from './redisClient';

/**
 * Centralized Database Loader
 * Handles connections for both MongoDB and Redis.
 * Includes Retry Logic for resilience on Railway.
 */
class DbLoader {
    private isConnected: boolean = false;
    private readonly MAX_RETRIES = 5;
    private readonly RETRY_DELAY_MS = 3000; // 3 seconds

    public async connect(): Promise<void> {
        if (this.isConnected) {
            logger.info("ℹ️ Database connections already active.");
            return;
        }

        logger.info('🚀 Initializing Infrastructure...');

        // 1. Connect MongoDB with Retry Logic
        if (!config.mongoUri) {
            throw new Error("❌ MongoDB URI missing in config");
        }

        let retries = 0;
        while (retries < this.MAX_RETRIES) {
            try {
                // Remove existing listeners to prevent duplicates on retry
                mongoose.connection.removeAllListeners('error');
                mongoose.connection.removeAllListeners('disconnected');

                // Attach Listeners
                mongoose.connection.on('error', (err) => logger.error(`🔥 MongoDB Error: ${err.message}`));
                mongoose.connection.on('disconnected', () => logger.warn('⚠️ MongoDB Disconnected'));

                // SCALING IMPROVEMENT: Dynamic pool size + Warm connections
                await mongoose.connect(config.mongoUri, {
                    maxPoolSize: config.mongoPoolSize, 
                    minPoolSize: 2, // Keep at least 2 connections warm
                    serverSelectionTimeoutMS: 5000, 
                    socketTimeoutMS: 45000, 
                });
                
                logger.info('✅ MongoDB Connected');
                break; // Success! Exit loop.

            } catch (err: any) {
                retries++;
                logger.error(`⚠️ MongoDB Connection Failed (Attempt ${retries}/${this.MAX_RETRIES}): ${err.message}`);
                
                if (retries >= this.MAX_RETRIES) {
                    logger.error(`❌ Critical Infrastructure Failure: Could not connect to MongoDB after ${this.MAX_RETRIES} attempts.`);
                    process.exit(1); // Give up
                }

                // Wait before retrying
                await new Promise(res => setTimeout(res, this.RETRY_DELAY_MS));
            }
        }

        // 2. Initialize Redis (Non-blocking failure is handled inside initRedis, but we await it here)
        await initRedis();

        this.isConnected = true;
        logger.info('✨ Infrastructure Ready');
    }

    public async disconnect(): Promise<void> {
        if (!this.isConnected) return;
        
        try {
            logger.info('🛑 Closing Infrastructure connections...');
            await redisClient.quit();
            await mongoose.disconnect(); 
            this.isConnected = false;
            logger.info('✅ Infrastructure closed gracefully.');
        } catch (err: any) {
            logger.error(`⚠️ Error during disconnect: ${err.message}`);
        }
    }
}

export default new DbLoader();
