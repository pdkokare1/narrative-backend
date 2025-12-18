// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';
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
                
                // 1. If Client is ready, execute command
                if (client && client.isReady) {
                    return await client.sendCommand(args);
                }

                // 2. CRITICAL FIX: Handling Startup Race Condition
                // If Redis is not ready yet (during server startup), we must NOT throw an error.
                // Throwing here crashes the entire Node process.
                
                // If the library is trying to load a script, return a dummy SHA to keep it happy.
                if (args.includes('SCRIPT') && args.includes('LOAD')) {
                    return "startup_placeholder_sha";
                }

                // Otherwise return null/undefined so the operation fails gracefully without crashing
                return null;
            } catch (e) {
                // Determine if we should log this as an error or just a warning
                const msg = e instanceof Error ? e.message : String(e);
                
                // Silence the "not ready" errors to keep logs clean
                if (msg !== 'Redis client not ready') {
                    logger.warn(`Redis Limit Warning (${type}): ${msg}`);
                }
                // Do NOT rethrow. Rethrowing crashes the app during init.
                return null; 
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
    // redisClient.isReady() here is correct because it calls our wrapper function in utils/redisClient.ts
    if (apiLimiterRedis && redisClient.isReady()) {
        return apiLimiterRedis(req, res, next);
    }
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
