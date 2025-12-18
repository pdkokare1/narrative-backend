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
    // 1. If client is already ready, return it.
    if (client && (client.isOpen || client.isReady)) {
        return client;
    }

    // 2. If a connection is currently being attempted, wait for it (Promise Lock)
    if (connectionPromise) {
        return connectionPromise;
    }

    // 3. Start a new connection attempt
    connectionPromise = (async () => {
        // Check configuration
        if (!config.redisOptions) {
            logger.warn("⚠️ Redis URL not set. Caching and Background Jobs will be disabled.");
            return null;
        }

        try {
            const newClient = createClient({
                ...config.redisOptions,
                socket: {
                    ...config.redisOptions.socket,
                    reconnectStrategy: (retries) => {
                        // Exponential backoff: max 5 seconds
                        const delay = Math.min(retries * 100, 5000);
                        logger.debug(`🔌 Redis reconnecting in ${delay}ms...`);
                        return delay;
                    },
                    connectTimeout: 10000, // Increased for Railway
                    keepAlive: 10000 
                }
            });

            newClient.on('error', (err) => {
                isHealthy = false;
                // Only log critical connection errors, ignore minor network blips
                if (!err.message.includes('ECONNREFUSED') && !err.message.includes('Socket closed')) {
                    logger.warn(`Redis Client Warning: ${err.message}`);
                }
            });

            newClient.on('connect', () => {
                logger.info('🔌 Redis Client Connecting...');
                isHealthy = true;
            });
            
            newClient.on('ready', () => {
                logger.info('✅ Redis Client Ready & Connected');
                isHealthy = true;
            });

            newClient.on('end', () => {
                logger.warn('🔌 Redis Client Disconnected');
                isHealthy = false;
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
            connectionPromise = null; // Release lock
        }
    })();

    return connectionPromise;
};

const redisClient = {
    // Helper: Safe Get (Fail-Safe)
    get: async (key: string): Promise<any | null> => {
        if (!client || !isHealthy) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e: any) {
            return null; // Fail silently, treat as cache miss
        }
    },

    // Helper: Multi Get
    mGet: async (keys: string[]): Promise<(string | null)[]> => {
        if (!client || !isHealthy || keys.length === 0) return [];
        try {
            return await client.mGet(keys);
        } catch (e: any) {
            return new Array(keys.length).fill(null);
        }
    },

    // Helper: Safe Set
    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !isHealthy) return;
        try {
            // Use 'EX' for seconds
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) {
            // Ignore set errors (caching is optional)
        }
    },

    // Helper: Smart Cache Wrapper with Stampede Protection
    getOrFetch: async <T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = 900): Promise<T> => {
        // 1. Try Cache First
        if (client && isHealthy) {
            try {
                const cachedData = await client.get(key);
                if (cachedData) {
                    return JSON.parse(cachedData) as T;
                }
            } catch (err) { 
                // Proceed to fetch if cache read fails
            }
        }

        // 2. Anti-Stampede: Check if a fetch is already running locally
        if (pendingFetches.has(key)) {
            return pendingFetches.get(key) as Promise<T>;
        }

        // 3. Define the Fetch Task
        const fetchPromise = (async () => {
            try {
                const freshData = await fetcher();
                // Only cache if we have data and Redis is up
                if (client && isHealthy && freshData) {
                    client.set(key, JSON.stringify(freshData), { EX: ttlSeconds }).catch(() => {});
                }
                return freshData;
            } catch (error) {
                throw error;
            }
        })();

        // 4. Store promise in map
        pendingFetches.set(key, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            pendingFetches.delete(key);
        }
    },
    
    // Helper: Delete
    del: async (key: string): Promise<void> => {
        if (!client || !isHealthy) return;
        try {
            await client.del(key);
        } catch (e) { /* ignore */ }
    },

    // Helper: Increment
    incr: async (key: string): Promise<number> => {
        if (!client || !isHealthy) return 0;
        try {
            return await client.incr(key);
        } catch (e) { return 0; }
    },

    // Helper: Expire
    expire: async (key: string, seconds: number): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try {
            return await client.expire(key, seconds);
        } catch (e) { return false; }
    },

    // Helper: Set Add
    sAdd: async (key: string, value: string): Promise<number> => {
        if (!client || !isHealthy) return 0;
        try {
            return await client.sAdd(key, value);
        } catch (e) { return 0; }
    },

    // Helper: Set Is Member
    sIsMember: async (key: string, value: string): Promise<boolean> => {
        if (!client || !isHealthy) return false;
        try {
            return await client.sIsMember(key, value);
        } catch (e) { return false; }
    },

    quit: async (): Promise<void> => {
        if (client) {
            await client.quit();
            isHealthy = false;
            logger.info('Redis connection closed gracefully.');
        }
    },

    getClient: () => client,
    isReady: () => isHealthy, // Simplified health check
};

export default redisClient;
