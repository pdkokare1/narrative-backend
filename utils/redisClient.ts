// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';
import config from './config';

let client: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType | null> | null = null;
let isHealthy = false;

// Anti-Stampede: Tracks in-flight fetch requests for getOrFetch
const pendingFetches = new Map<string, Promise<any>>();

export const initRedis = async (): Promise<RedisClientType | null> => {
    // 1. Return existing client if ready
    if (client && (client.isOpen || client.isReady)) {
        return client;
    }

    // 2. Return existing promise if initialization is in progress
    if (connectionPromise) {
        return connectionPromise;
    }

    // 3. Start new connection logic
    connectionPromise = (async () => {
        if (!config.redisUrl && !config.redisOptions) {
            logger.warn("⚠️ Redis URL/Options not set. Caching and Background Jobs will be disabled.");
            return null;
        }

        try {
            // Merge config options
            const clientConfig = config.redisUrl 
                ? { url: config.redisUrl } 
                : { ...config.redisOptions };

            const newClient = createClient({
                ...clientConfig,
                socket: {
                    ...((clientConfig as any).socket || {}),
                    reconnectStrategy: (retries) => {
                        // Exponential backoff: 100ms, 200ms, ... max 5000ms
                        return Math.min(retries * 100, 5000);
                    },
                    connectTimeout: 10000, 
                    keepAlive: 10000 
                }
            });

            newClient.on('error', (err) => {
                isHealthy = false;
                // suppress repetitive connection refused logs
                if (!err.message.includes('ECONNREFUSED') && !err.message.includes('Socket closed')) {
                    logger.warn(`Redis Client Warning: ${err.message}`);
                }
            });

            newClient.on('connect', () => {
                // Connected but not yet ready to accept commands
            });
            
            newClient.on('ready', () => {
                logger.info('✅ Redis Client Ready & Connected');
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
    get: async (key: string): Promise<any | null> => {
        if (!client || !isHealthy) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e: any) { return null; }
    },

    mGet: async (keys: string[]): Promise<(string | null)[]> => {
        if (!client || !isHealthy || keys.length === 0) return [];
        try {
            return await client.mGet(keys);
        } catch (e: any) { return new Array(keys.length).fill(null); }
    },

    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !isHealthy) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) { }
    },

    // --- ENHANCED: getOrFetch with robustness ---
    getOrFetch: async <T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = 900): Promise<T> => {
        // 1. Try Cache
        if (client && isHealthy) {
            try {
                const cachedData = await client.get(key);
                if (cachedData) {
                    return JSON.parse(cachedData) as T;
                }
            } catch (err) { /* proceed */ }
        }

        // 2. Anti-Stampede (Local Memory)
        if (pendingFetches.has(key)) {
            return pendingFetches.get(key) as Promise<T>;
        }

        // 3. Execute Fetch
        const fetchPromise = (async () => {
            try {
                const freshData = await fetcher();
                if (client && isHealthy && freshData) {
                    // Fire and forget cache update
                    client.set(key, JSON.stringify(freshData), { EX: ttlSeconds }).catch(() => {});
                }
                return freshData;
            } catch (error) {
                throw error;
            }
        })();

        pendingFetches.set(key, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            pendingFetches.delete(key);
        }
    },

    // --- CRITICAL SECURITY FIX: Fail Closed Locking ---
    // If Redis is down, we return FALSE. This prevents expensive jobs (like AI)
    // from running without a lock and causing billing spikes.
    acquireLock: async (key: string, ttlSeconds: number = 60): Promise<boolean> => {
        if (!client || !isHealthy) {
            logger.warn(`⚠️ Cannot acquire lock '${key}': Redis unavailable.`);
            return false; // Fail Closed
        } 
        try {
            const result = await client.set(key, 'LOCKED_BY_JOB', {
                NX: true, // Only set if not exists
                EX: ttlSeconds
            });
            return result === 'OK';
        } catch (e) {
            logger.warn(`⚠️ Error acquiring lock '${key}': ${e}`);
            return false; // Fail Closed on error
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

    sAdd: async (key: string, value: string): Promise<number> => {
        if (!client || !isHealthy) return 0;
        try { return await client.sAdd(key, value); } catch (e) { return 0; }
    },

    sIsMember: async (key: string, value: string): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try { return await client.sIsMember(key, value); } catch (e) { return false; }
    },

    // Used for clean shutdowns
    disconnect: async (): Promise<void> => {
        if (client) {
            try {
                if (client.isOpen) {
                    await client.quit();
                }
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
