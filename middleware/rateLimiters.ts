// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
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
 * Now accepts the actual Redis client instance
 */
const createRedisLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    const client = redisClient.getClient();
    
    // Safety check: Cannot create Redis store without a valid client
    if (!client) return null;

    const store = new RedisStore({
        // @ts-ignore - Compatible with RedisClientType
        sendCommand: (...args: string[]) => client.sendCommand(args),
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
        skipFailedRequests: true, // Fail open if Redis errors occur during limit check
        handler: (req: Request, res: Response, next: NextFunction, options) => {
            logger.warn(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
            res.status(options.statusCode).send(options.message);
        },
    });
};

// --- Singleton Limiters ---

// 1. Memory Fallbacks (Always available)
const apiLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
const ttsLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');

// 2. Redis Limiters (Lazy loaded)
let apiLimiterRedis: RateLimitRequestHandler | null = null;
let ttsLimiterRedis: RateLimitRequestHandler | null = null;

// --- Dynamic Middleware Wrapper ---

/**
 * Dynamic API Limiter
 * Automatically upgrades to Redis when connection is available.
 */
export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    // 1. Check if Redis is healthy
    if (redisClient.isReady()) {
        // 2. Initialize Redis limiter if not already done
        if (!apiLimiterRedis) {
            apiLimiterRedis = createRedisLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
        }
        
        // 3. Use Redis limiter if successfully created
        if (apiLimiterRedis) {
            return apiLimiterRedis(req, res, next);
        }
    }
    
    // 4. Fallback to Memory
    return apiLimiterMemory(req, res, next);
};

/**
 * Dynamic TTS Limiter
 */
export const ttsLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        if (!ttsLimiterRedis) {
            ttsLimiterRedis = createRedisLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');
        }
        
        if (ttsLimiterRedis) {
            return ttsLimiterRedis(req, res, next);
        }
    }
    return ttsLimiterMemory(req, res, next);
};
