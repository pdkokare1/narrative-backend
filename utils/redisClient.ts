// utils/redisClient.ts
import { createClient, RedisClientType } from 'redis';
import logger from './logger';

let client: RedisClientType | null = null;

const initRedis = async () => {
    if (!process.env.REDIS_URL) {
        logger.warn("⚠️ Redis URL not found. Caching will be disabled.");
        return null;
    }

    try {
        client = createClient({
            url: process.env.REDIS_URL,
            socket: {
                reconnectStrategy: (retries: number) => {
                    if (retries > 10) {
                        logger.error("❌ Redis max retries reached. Giving up.");
                        return new Error("Redis Retry Limit");
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        });

        client.on('error', (err: Error) => logger.warn(`Redis Client Error: ${err.message}`));
        client.on('connect', () => logger.info('✅ Redis Connected'));

        await client.connect();
        return client;
    } catch (err: any) {
        logger.error(`❌ Redis Connection Failed: ${err.message}`);
        return null;
    }
};

// Initialize immediately
initRedis();

const redisClient = {
    get: async (key: string): Promise<any | null> => {
        if (!client || !client.isOpen) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            return null;
        }
    },

    set: async (key: string, data: any, ttlSeconds: number = 900): Promise<void> => {
        if (!client || !client.isOpen) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e: any) {
            logger.warn(`Redis Set Error: ${e.message}`);
        }
    },
    
    isReady: (): boolean => !!(client && client.isOpen)
};

export default redisClient;
