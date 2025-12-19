// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';
import config from './config';

let client: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType | null> | null = null;
let isHealthy = false;

/**
 * Initialize Redis Connection
 * Designed to be called by dbLoader.ts
 */
export const initRedis = async (): Promise<RedisClientType | null> => {
    if (client && (client.isOpen || client.isReady)) {
        return client;
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        if (!config.redisUrl && !config.redisOptions) {
            logger.warn("⚠️ Redis URL/Options not set. Caching and Background Jobs will be disabled.");
            return null;
        }

        try {
            const clientConfig = config.redisUrl 
                ? { url: config.redisUrl } 
                : { ...config.redisOptions };

            const newClient = createClient({
                ...clientConfig,
                socket: {
                    ...((clientConfig as any).socket || {}),
                    reconnectStrategy: (retries) => {
                        if (retries > 20) {
                             logger.error("❌ Redis: Max Retries Reached. Waiting 5s...");
                             return 5000;
                        }
                        return Math.min(retries * 100, 3000);
                    },
                    connectTimeout: 15000, 
                    keepAlive: 15000 
                }
            });

            newClient.on('error', (err) => {
                isHealthy = false;
                if (!err.message.includes('ECONNREFUSED') && !err.message.includes('Socket closed')) {
                    logger.warn(`Redis Client Warning: ${err.message}`);
                }
            });

            newClient.on('ready', () => {
                if (!isHealthy) logger.info('✅ Redis Client Ready & Connected');
                isHealthy = true;
            });

            newClient.on('end', () => {
                isHealthy = false;
                logger.warn('Redis Client Disconnected');
            });

            await newClient.connect();
            client = newClient as RedisClientType; 
            return client;

        } catch (err: any) {
            logger.error(`❌ Redis Initialization Failed: ${err.message}`);
            client = null;
            isHealthy = false;
            return null;
        } finally {
            connectionPromise = null;
        }
    })();

    return connectionPromise;
};

const redisClient = {
    // --- BASIC OPS ---

    get: async (key: string): Promise<any | null> => {
        if (!client || !isHealthy) return null;
        try {
            const data = await client.get(key);
            try { return data ? JSON.parse(data) : null; } catch { return data; }
        } catch (e: any) { return null; }
    },

    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !isHealthy) return;
        try {
            const value = typeof data === 'string' ? data : JSON.stringify(data);
            await client.set(key, value, { EX: ttlSeconds });
        } catch (e: any) { 
            logger.warn(`Redis Set Error: ${e.message}`);
        }
    },

    del: async (key: string): Promise<void> => {
        if (!client || !isHealthy) return;
        try { await client.del(key); } catch (e) { }
    },

    incr: async (key: string): Promise<number> => {
        if (!client || !isHealthy) return 0;
        try { return await client.incr(key); } catch (e) { return 0; }
    },

    expire: async (key: string, seconds: number): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try { return await client.expire(key, seconds); } catch (e) { return false; }
    },

    // --- SETS ---

    sAdd: async (key: string, value: string): Promise<number> => {
        if (!client || !isHealthy) return 0;
        try { return await client.sAdd(key, value); } catch (e) { return 0; }
    },

    sIsMember: async (key: string, value: string): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try { return await client.sIsMember(key, value); } catch (e) { return false; }
    },

    // --- ADVANCED: Distributed Lock & Fetch ---

    /**
     * Intelligent Fetch with Distributed Locking
     * Ensures only ONE server performs the fetch logic when cache is missing.
     */
    getOrFetch: async <T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = 900): Promise<T> => {
        // 1. Try Cache First
        if (client && isHealthy) {
            try {
                const cachedData = await client.get(key);
                if (cachedData) return JSON.parse(cachedData) as T;
            } catch (err) { /* Ignore cache read error */ }
        }

        if (!client || !isHealthy) {
            // Redis dead? Fallback to direct fetch
            return await fetcher();
        }

        const lockKey = `lock:${key}`;
        const retryCount = 10;
        const retryDelay = 200; // ms

        // 2. Distributed Lock Loop
        for (let i = 0; i < retryCount; i++) {
            // Try to acquire lock
            const acquired = await client.set(lockKey, 'LOCKED', { NX: true, PX: 5000 }); // 5s lock

            if (acquired) {
                try {
                    // Double check cache in case it was just set
                    const cachedData = await client.get(key);
                    if (cachedData) return JSON.parse(cachedData) as T;

                    // We have the lock, do the work
                    const freshData = await fetcher();
                    
                    if (freshData) {
                        await client.set(key, JSON.stringify(freshData), { EX: ttlSeconds });
                    }
                    return freshData;
                } finally {
                    await client.del(lockKey); // Release lock
                }
            }

            // Lock busy? Wait and check cache again
            await new Promise(r => setTimeout(r, retryDelay));
            
            const cachedAfterWait = await client.get(key);
            if (cachedAfterWait) return JSON.parse(cachedAfterWait) as T;
        }

        // 3. Timeout - Just fetch it locally if we couldn't get the lock
        logger.warn(`⚠️ Lock timeout for ${key}, fetching directly.`);
        return await fetcher();
    },

    // --- LOCKING (Workers) ---
    
    acquireLock: async (key: string, ttlSeconds: number = 60): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try {
            const result = await client.set(key, 'LOCKED_BY_JOB', {
                NX: true,
                EX: ttlSeconds
            });
            return result === 'OK';
        } catch (e) {
            return false; 
        }
    },

    releaseLock: async (key: string): Promise<void> => {
        if (!client || !isHealthy) return;
        try { await client.del(key); } catch (e) {}
    },

    disconnect: async (): Promise<void> => {
        if (client) {
            try {
                if (client.isOpen) await client.quit();
                logger.info('✅ Redis Connection Closed');
            } catch (e) {
                logger.error('Error closing Redis connection');
            } finally {
                client = null;
                isHealthy = false;
            }
        }
    },

    getClient: () => client,
    isReady: () => isHealthy,
};

export default redisClient;
