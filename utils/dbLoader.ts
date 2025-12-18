// utils/dbLoader.ts
import mongoose from 'mongoose';
import config from './config';
import logger from './logger';
import { initRedis, default as redisClient } from './redisClient';

/**
 * Centralized Database Loader
 * Handles connections for both MongoDB and Redis.
 * IMPROVED: Uses Parallel Loading for faster startup.
 */
class DbLoader {
    private isConnected: boolean = false;
    private readonly MAX_RETRIES = 5;
    private readonly RETRY_DELAY_MS = 3000;

    public async connect(): Promise<void> {
        if (this.isConnected) {
            logger.info("ℹ️ Database connections already active.");
            return;
        }

        logger.info('🚀 Initializing Infrastructure...');

        if (!config.mongoUri) {
            throw new Error("❌ MongoDB URI missing in config");
        }

        // --- PARALLEL LOADING START ---
        // We trigger both connections at the same time.
        
        const mongoPromise = this.connectMongo();
        
        // Redis is optional but recommended. We catch errors here so they don't block MongoDB.
        // This solves the 'double connect' issue by managing it here.
        const redisPromise = initRedis().catch(err => {
            logger.warn(`⚠️ Redis Initialization failed: ${err.message}. App will run with limited caching.`);
            return null;
        });

        // Wait for both to settle
        await Promise.all([mongoPromise, redisPromise]);
        // --- PARALLEL LOADING END ---

        this.isConnected = true;
        logger.info('✨ Infrastructure Ready (Parallel Boot Complete)');
    }

    private async connectMongo(): Promise<void> {
        let retries = 0;
        while (retries < this.MAX_RETRIES) {
            try {
                // Clear previous listeners to avoid duplicates on reconnect
                mongoose.connection.removeAllListeners('error');
                mongoose.connection.removeAllListeners('disconnected');

                mongoose.connection.on('error', (err) => logger.error(`🔥 MongoDB Error: ${err.message}`));
                mongoose.connection.on('disconnected', () => logger.warn('⚠️ MongoDB Disconnected'));

                await mongoose.connect(config.mongoUri, {
                    maxPoolSize: config.mongoPoolSize, 
                    minPoolSize: 2, 
                    serverSelectionTimeoutMS: 5000, 
                    socketTimeoutMS: 45000, 
                });
                
                logger.info('✅ MongoDB Connected');
                return; // Success

            } catch (err: any) {
                retries++;
                logger.error(`⚠️ MongoDB Connection Failed (Attempt ${retries}/${this.MAX_RETRIES}): ${err.message}`);
                
                if (retries >= this.MAX_RETRIES) {
                    logger.error(`❌ Critical Infrastructure Failure: Could not connect to MongoDB after ${this.MAX_RETRIES} attempts.`);
                    process.exit(1); 
                }

                await new Promise(res => setTimeout(res, this.RETRY_DELAY_MS));
            }
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.isConnected) return;
        
        try {
            logger.info('🛑 Closing Infrastructure connections...');
            // Close in parallel for faster shutdown
            await Promise.all([
                redisClient.disconnect(),
                mongoose.disconnect()
            ]);
            this.isConnected = false;
            logger.info('✅ Infrastructure closed gracefully.');
        } catch (err: any) {
            logger.error(`⚠️ Error during disconnect: ${err.message}`);
        }
    }
}

export default new DbLoader();
