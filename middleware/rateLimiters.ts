// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import config from '../utils/config';
import logger from '../utils/logger';

/**
 * Key Generator:
 * Uses User ID if authenticated, otherwise falls back to IP.
 */
const keyGenerator = (req: Request | any): string => {
    if (req.user && req.user.uid) {
        return `limiter:${req.user.uid}`;
    }
    return req.ip || 'unknown-ip';
};

/**
 * Factory to create a Memory Store Limiter (Fallback)
 */
const createMemoryLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    return rateLimit({
        windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
        max: maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: keyGenerator,
        message: { 
            status: 'error',
            message: type === 'API' 
                ? 'Too many requests, please try again later.' 
                : 'Audio generation limit reached.' 
        },
        skipFailedRequests: true,
    });
};

/**
 * Factory to create a Redis Store Limiter (Primary)
 */
const createRedisLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    // Only attempt to create if URL exists, otherwise return null
    if (!config.redisUrl) return null;

    const store = new RedisStore({
        // @ts-ignore - RedisClientType compatibility wrapper
        sendCommand: async (...args: string[]) => {
            try {
                const client = redisClient.getClient();
                // CRITICAL FIX: If client isn't ready, THROW error instead of returning null.
                // Returning null causes rate-limit-redis to crash with TypeError.
                // Throwing an error allows skipFailedRequests to handle it gracefully.
                if (client && client.isReady) {
                    return await client.sendCommand(args);
                }
                throw new Error('Redis client not ready');
            } catch (e) {
                // Determine if we should log this as an error or just a warning
                // During startup, "not ready" is expected.
                const msg = e instanceof Error ? e.message : String(e);
                if (msg !== 'Redis client not ready') {
                    logger.error(`Redis Limit Error (${type}):`, e);
                }
                throw e; // Propagate to express-rate-limit
            }
        },
    });

    return rateLimit({
        windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
        max: maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: keyGenerator,
        store: store,
        message: { 
            status: 'error',
            message: type === 'API' 
                ? 'Too many requests, please try again later.' 
                : 'Audio generation limit reached.' 
        },
        // If Redis fails (or is not ready), we allow the request to proceed (Fail Open)
        // This prevents the "Unexpected reply" crash.
        skipFailedRequests: true, 
        handler: (req: Request, res: Response, next: NextFunction, options) => {
            logger.warn(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
            res.status(options.statusCode).send(options.message);
        },
    });
};

// --- Instantiate Limiters ---

// 1. Create Memory Fallbacks
const apiLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
const ttsLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');

// 2. Create Redis Limiters (might be null if no config)
const apiLimiterRedis = createRedisLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
const ttsLimiterRedis = createRedisLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');

// --- Export Dynamic Middleware ---

/**
 * Dynamic API Limiter
 * - If Redis is configured and READY: Use Redis Limiter
 * - If Redis is configured but NOT READY: Use Memory Limiter (Fallback)
 * - If Redis is NOT configured: Use Memory Limiter
 */
export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (apiLimiterRedis && redisClient.isReady()) {
        return apiLimiterRedis(req, res, next);
    }
    // Log once per startup/outage if needed, or keep silent to avoid log spam
    return apiLimiterMemory(req, res, next);
};

/**
 * Dynamic TTS Limiter
 */
export const ttsLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (ttsLimiterRedis && redisClient.isReady()) {
        return ttsLimiterRedis(req, res, next);
    }
    return ttsLimiterMemory(req, res, next);
};
