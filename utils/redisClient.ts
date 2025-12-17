// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';
import config from './config';

let client: RedisClientType | null = null;

/**
 * Helper: Parses the REDIS_URL into a config object.
 * Centralizes logic so QueueManager and RedisClient don't have to guess.
 */
export const parseRedisConfig = () => {
    if (!config.redisUrl) return null;
    
    try {
        const url = new URL(config.redisUrl);
        const connectionConfig: any = {
            host: url.hostname,
            port: Number(url.port),
            password: url.password,
            username: url.username,
        };

        // Handle rediss:// protocol (TLS) for production (Railway/Render/AWS)
        if (url.protocol === 'rediss:') {
            connectionConfig.tls = { rejectUnauthorized: false };
        }

        return connectionConfig;
    } catch (e: any) {
        logger.error(`❌ Error parsing Redis URL: ${e.message}`);
        return null;
    }
};

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
                // Exponential backoff for reconnects
                reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
                // FAIL FAST: Only wait 5 seconds for initial connection
                connectTimeout: 5000,
                // Keep-alive to prevent Railway/Cloud closing idle connections
                keepAlive: 10000 
            }
        });

        client.on('error', (err) => {
            // Log error but don't crash
            logger.warn(`Redis Client Warning: ${err.message}`);
        });

        client.on('connect', () => logger.info('🔌 Redis Client Connecting...'));
        client.on('ready', () => logger.info('✅ Redis Client Ready & Connected'));

        await client.connect();
        return client;

    } catch (err: any) {
        logger.error(`❌ Redis Initialization Failed: ${err.message}`);
        // Ensure client is null so we don't try to use a broken client
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
            return null;
        }
    },

    // Helper: Multi Get (Batch Optimization)
    mGet: async (keys: string[]): Promise<(string | null)[]> => {
        if (!client || !client.isReady || keys.length === 0) return [];
        try {
            return await client.mGet(keys);
        } catch (e: any) {
            logger.warn(`Redis mGet Error: ${e.message}`);
            return new Array(keys.length).fill(null);
        }
    },

    // Helper: Safe Set
    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !client.isReady) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) {
            // Ignore set errors
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

    // Direct Access (Important for libraries like rate-limit-redis or bulk ops)
    getClient: () => client,
    isReady: () => client?.isReady ?? false,
    
    // Export the parser for other files (like QueueManager)
    parseRedisConfig
};

export default redisClient;
