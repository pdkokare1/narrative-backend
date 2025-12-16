// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';
import config from './config';

let client: RedisClientType | null = null;

export const initRedis = async () => {
    // If client exists and is ready, return it immediately
    if (client && (client.isOpen || client.isReady)) {
        return client;
    }

    // Check configuration
    if (!config.redisUrl) {
        logger.warn("⚠️ Redis URL not found in config. Caching and Background Jobs will be disabled.");
        return null;
    }

    try {
        client = createClient({
            url: config.redisUrl,
            socket: {
                // Exponential backoff: Start at 100ms, cap at 5000ms
                reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
            }
        });

        client.on('error', (err) => {
            logger.error(`❌ Redis Client Error: ${err.message}`);
        });

        client.on('connect', () => logger.info('🔌 Redis Client Connecting...'));
        client.on('reconnecting', () => logger.info('🔄 Redis Reconnecting...'));
        client.on('ready', () => logger.info('✅ Redis Client Ready & Connected'));

        await client.connect();
        return client;

    } catch (err: any) {
        logger.error(`❌ Redis Initialization Failed: ${err.message}`);
        client = null;
        return null;
    }
};

const redisClient = {
    // Helper: Safe Get
    get: async (key: string): Promise<any | null> => {
        if (!client || !client.isReady) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e: any) {
            logger.warn(`Redis Get Error [${key}]: ${e.message}`);
            return null;
        }
    },

    // Helper: Safe Set
    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !client.isReady) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) {
            logger.warn(`Redis Set Error [${key}]: ${e.message}`);
        }
    },
    
    // Helper: Delete
    del: async (key: string): Promise<void> => {
        if (!client || !client.isReady) return;
        try {
            await client.del(key);
        } catch (e) { /* ignore */ }
    },

    // Helper: Increment
    incr: async (key: string): Promise<number> => {
        if (!client || !client.isReady) return 0;
        try {
            return await client.incr(key);
        } catch (e) { return 0; }
    },

    // Helper: Expire
    expire: async (key: string, seconds: number): Promise<boolean> => {
        if (!client || !client.isReady) return false;
        try {
            return await client.expire(key, seconds);
        } catch (e) { return false; }
    },

    // Helper: Set Add (Sets)
    sAdd: async (key: string, value: string): Promise<number> => {
        if (!client || !client.isReady) return 0;
        try {
            return await client.sAdd(key, value);
        } catch (e) { return 0; }
    },

    // Helper: Set Is Member
    sIsMember: async (key: string, value: string): Promise<boolean> => {
        if (!client || !client.isReady) return false;
        try {
            return await client.sIsMember(key, value);
        } catch (e) { return false; }
    },

    // System: Graceful Quit
    quit: async (): Promise<void> => {
        if (client) {
            await client.quit();
            logger.info('Redis connection closed gracefully.');
        }
    },

    // Direct Access (Important for libraries like rate-limit-redis)
    getClient: () => client,
    isReady: () => client?.isReady ?? false
};

export default redisClient;
