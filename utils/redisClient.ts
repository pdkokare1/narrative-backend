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
    if (!config.redisOptions) {
        logger.warn("⚠️ Redis URL not set. Caching and Background Jobs will be disabled.");
        return null;
    }

    try {
        client = createClient({
            ...config.redisOptions, // Use centralized config
            socket: {
                ...config.redisOptions.socket, // Preserve socket settings if any
                reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
                connectTimeout: 5000,
                keepAlive: 10000 
            }
        });

        client.on('error', (err) => {
            logger.warn(`Redis Client Warning: ${err.message}`);
        });

        client.on('connect', () => logger.info('🔌 Redis Client Connecting...'));
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
            return null;
        }
    },

    // Helper: Multi Get
    mGet: async (keys: string[]): Promise<(string | null)[]> => {
        if (!client || !client.isReady || keys.length === 0) return [];
        try {
            return await client.mGet(keys);
        } catch (e: any) {
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

    // Helper: Smart Cache Wrapper
    getOrFetch: async <T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = 900): Promise<T> => {
        if (client && client.isReady) {
            try {
                const cachedData = await client.get(key);
                if (cachedData) {
                    return JSON.parse(cachedData) as T;
                }
            } catch (err) { /* proceed */ }
        }

        const freshData = await fetcher();

        if (client && client.isReady && freshData) {
            client.set(key, JSON.stringify(freshData), { EX: ttlSeconds }).catch(() => {});
        }

        return freshData;
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

    // Helper: Set Add
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

    quit: async (): Promise<void> => {
        if (client) {
            await client.quit();
            logger.info('Redis connection closed gracefully.');
        }
    },

    getClient: () => client,
    isReady: () => client?.isReady ?? false,
};

export default redisClient;
