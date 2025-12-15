// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';

let client: RedisClientType | null = null;
let isConnected = false;

const initRedis = async () => {
    if (!process.env.REDIS_URL) {
        logger.warn("⚠️ Redis URL not found. Caching will be disabled.");
        return null;
    }

    try {
        client = createClient({
            url: process.env.REDIS_URL,
            socket: {
                // Stop reconnecting after 5 failures to prevent log flooding
                reconnectStrategy: (retries: number) => {
                    if (retries > 5) {
                        logger.error("❌ Redis max retries reached. Caching disabled.");
                        return new Error("Redis Retry Limit");
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });

        client.on('error', (err: Error) => {
            // Only log if we haven't already decided it's dead
            if (isConnected) logger.warn(`Redis Client Error: ${err.message}`);
            isConnected = false;
        });

        client.on('connect', () => {
            logger.info('✅ Redis Connected');
            isConnected = true;
        });

        await client.connect();
        return client;
    } catch (err: any) {
        logger.error(`❌ Redis Connection Failed: ${err.message}`);
        client = null;
        isConnected = false;
        return null;
    }
};

// Initialize immediately but don't await (allows app to start)
initRedis();

const redisClient = {
    get: async (key: string): Promise<any | null> => {
        if (!client || !isConnected) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            return null;
        }
    },

    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !isConnected) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) {
            logger.warn(`Redis Set Error: ${e.message}`);
        }
    },
    
    del: async (key: string): Promise<void> => {
        if (!client || !isConnected) return;
        try {
            await client.del(key);
        } catch (e) {
            // ignore
        }
    },

    // --- COUNTERS ---
    incr: async (key: string): Promise<number> => {
        if (!client || !isConnected) return 0;
        try {
            return await client.incr(key);
        } catch (e: any) {
            logger.warn(`Redis Incr Error: ${e.message}`);
            return 0;
        }
    },

    expire: async (key: string, seconds: number): Promise<boolean> => {
        if (!client || !isConnected) return false;
        try {
            return await client.expire(key, seconds);
        } catch (e: any) {
            logger.warn(`Redis Expire Error: ${e.message}`);
            return false;
        }
    },

    // --- SETS (For Gatekeeper & Tags) ---
    sAdd: async (key: string, value: string): Promise<number> => {
        if (!client || !isConnected) return 0;
        try {
            return await client.sAdd(key, value);
        } catch (e) { return 0; }
    },

    sIsMember: async (key: string, value: string): Promise<boolean> => {
        if (!client || !isConnected) return false;
        try {
            return await client.sIsMember(key, value);
        } catch (e) { return false; }
    },

    isReady: () => isConnected,
    getClient: () => client // Direct access if needed
};

export default redisClient;
