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
 * Factory to create a limiter (Memory or Redis)
 */
const createLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    // CHANGED: We now attempt to use Redis if a URL is configured,
    // regardless of whether the client is 'ready' at this exact nanosecond.
    const isRedisConfigured = !!config.redisUrl;
    
    let store;

    if (isRedisConfigured) {
        store = new RedisStore({
            // @ts-ignore - RedisClientType compatibility wrapper
            sendCommand: async (...args: string[]) => {
                try {
                    const client = redisClient.getClient();
                    // We check readiness HERE, dynamically, per request
                    if (client && client.isReady) {
                        return await client.sendCommand(args);
                    }
                    // If Redis disconnects briefly, this returns null 
                    // which causes rate-limit-redis to fall back to memory temporarily
                    return null;
                } catch (e) {
                    logger.error(`Redis Limit Error (${type}):`, e);
                    return null;
                }
            },
        });
        logger.info(`✅ Rate Limiter (${type}) configured with Redis Store strategy`);
    } else {
        logger.warn(`⚠️ Rate Limiter (${type}) using Memory Store (No Redis URL)`);
    }

    return rateLimit({
        windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
        max: maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: keyGenerator,
        store: store, // If undefined (no Redis URL), defaults to MemoryStore
        message: { 
            status: 'error',
            message: type === 'API' 
                ? 'Too many requests, please try again later.' 
                : 'Audio generation limit reached.' 
        },
        handler: (req: Request, res: Response, next: NextFunction, options) => {
            logger.warn(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
            res.status(options.statusCode).send(options.message);
        },
        skipFailedRequests: true, // Don't count 5xx errors against the user's limit
    });
};

// Initialize limiters once at startup
export const apiLimiter = createLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
export const ttsLimiter = createLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');
