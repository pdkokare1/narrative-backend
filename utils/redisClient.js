// utils/redisClient.js
const { createClient } = require('redis');
const logger = require('./logger');

let client = null;

const initRedis = async () => {
    if (!process.env.REDIS_URL) {
        logger.warn("⚠️ Redis URL not found. Caching will be disabled.");
        return null;
    }

    try {
        client = createClient({
            url: process.env.REDIS_URL,
            socket: {
                reconnectStrategy: (retries) => {
                    if (retries > 10) {
                        logger.error("❌ Redis max retries reached. Giving up.");
                        return new Error("Redis Retry Limit");
                    }
                    return Math.min(retries * 100, 3000); // Backoff strategy
                }
            }
        });

        client.on('error', (err) => logger.warn(`Redis Client Error: ${err.message}`));
        client.on('connect', () => logger.info('✅ Redis Connected'));

        await client.connect();
        return client;
    } catch (err) {
        logger.error(`❌ Redis Connection Failed: ${err.message}`);
        return null;
    }
};

// Initialize immediately but don't block
initRedis();

module.exports = {
    // Helper: Get parsed JSON
    get: async (key) => {
        if (!client || !client.isOpen) return null;
        try {
            const data = await client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            return null;
        }
    },

    // Helper: Set stringified JSON with Expiry (TTL in seconds)
    set: async (key, data, ttlSeconds = 900) => {
        if (!client || !client.isOpen) return;
        try {
            await client.set(key, JSON.stringify(data), { EX: ttlSeconds });
        } catch (e) {
            logger.warn(`Redis Set Error: ${e.message}`);
        }
    },
    
    // Check health
    isReady: () => client && client.isOpen
};
