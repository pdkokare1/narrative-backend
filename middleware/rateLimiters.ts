// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import { CONSTANTS } from '../utils/constants';

const keyGenerator = (req: Request | any): string => {
    // Check if user is authenticated via authMiddleware
    if (req.user && req.user.uid) {
        return `limiter:${req.user.uid}`;
    }
    // Fallback to IP address
    return req.ip || 'unknown-ip';
};

// --- Factory: Create Memory Limiter (Backup) ---
const createMemoryLimiter = (maxRequests: number, windowMs: number, type: string) => {
    return rateLimit({
        windowMs: windowMs,
        max: maxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: keyGenerator,
        message: { 
            status: 'error',
            message: `Too many ${type} requests. Please try again later.`
        },
        skipFailedRequests: true,
    });
};

// --- Factory: Create Redis Limiter (Primary) ---
const createRedisLimiter = (maxRequests: number, windowMs: number, type: string): RateLimitRequestHandler | null => {
    const client = redisClient.getClient();
    
    // Safety check: ensure client exists and is actually connected
    if (!client || !redisClient.isReady()) {
        return null;
    }

    try {
        const store = new RedisStore({
            // Pass the actual Redis client instance
            // @ts-ignore: library type mismatch usually occurs here, but passing the client instance is correct for ioredis/node-redis
            sendCommand: (...args: string[]) => client.sendCommand(args),
        });

        return rateLimit({
            windowMs: windowMs,
            max: maxRequests,
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: keyGenerator,
            store: store,
            message: { 
                status: 'error',
                message: `Too many ${type} requests. Please try again later.`
            },
            skipFailedRequests: true,
            handler: (req: Request, res: Response, next: NextFunction, options) => {
                logger.warn(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
                res.status(options.statusCode).send(options.message);
            },
        });
    } catch (e) {
        logger.warn(`Failed to create Redis limiter: ${e}`);
        return null;
    }
};

// --- CONFIGURATION FROM CONSTANTS ---
const API_WINDOW = CONSTANTS.RATE_LIMIT.WINDOW_MS;
const API_MAX = CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS;

// Search: 1 Minute Window (Strict)
const SEARCH_WINDOW = 60 * 1000; 
const SEARCH_MAX = 30;

// TTS: Expensive
const TTS_WINDOW = CONSTANTS.RATE_LIMIT.WINDOW_MS;
const TTS_MAX = CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS;

// --- SINGLETON INITIALIZATION ---

// Memory Backups (Always created)
const apiLimiterMemory = createMemoryLimiter(API_MAX, API_WINDOW, 'API');
const searchLimiterMemory = createMemoryLimiter(SEARCH_MAX, SEARCH_WINDOW, 'Search');
const ttsLimiterMemory = createMemoryLimiter(TTS_MAX, TTS_WINDOW, 'Audio');

// Redis Placeholders
let apiLimiterRedis: RateLimitRequestHandler | null = null;
let searchLimiterRedis: RateLimitRequestHandler | null = null;
let ttsLimiterRedis: RateLimitRequestHandler | null = null;

// --- EXPORTED MIDDLEWARE ---

export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        // Lazy Instantiation: Create only when needed and Redis is up
        if (!apiLimiterRedis) apiLimiterRedis = createRedisLimiter(API_MAX, API_WINDOW, 'API');
        if (apiLimiterRedis) return apiLimiterRedis(req, res, next);
    }
    // Fallback
    return apiLimiterMemory(req, res, next);
};

export const searchLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        if (!searchLimiterRedis) searchLimiterRedis = createRedisLimiter(SEARCH_MAX, SEARCH_WINDOW, 'Search');
        if (searchLimiterRedis) return searchLimiterRedis(req, res, next);
    }
    return searchLimiterMemory(req, res, next);
};

export const ttsLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        if (!ttsLimiterRedis) ttsLimiterRedis = createRedisLimiter(TTS_MAX, TTS_WINDOW, 'Audio');
        if (ttsLimiterRedis) return ttsLimiterRedis(req, res, next);
    }
    return ttsLimiterMemory(req, res, next);
};
