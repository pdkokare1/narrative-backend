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
// Note: This must NOT be called inside a request handler to avoid validation errors
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
                // CHANGED: Use debug level to prevent log flooding during attacks/spikes
                logger.debug(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
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

const SEARCH_WINDOW = 60 * 1000; 
const SEARCH_MAX = 30;

const TTS_WINDOW = CONSTANTS.RATE_LIMIT.WINDOW_MS;
const TTS_MAX = CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS;

// --- INITIALIZATION ---

// 1. Create Memory Backups (Always available)
const apiLimiterMemory = createMemoryLimiter(API_MAX, API_WINDOW, 'API');
const searchLimiterMemory = createMemoryLimiter(SEARCH_MAX, SEARCH_WINDOW, 'Search');
const ttsLimiterMemory = createMemoryLimiter(TTS_MAX, TTS_WINDOW, 'Audio');

// 2. Redis Limiters (Initially null)
let apiLimiterRedis: RateLimitRequestHandler | null = null;
let searchLimiterRedis: RateLimitRequestHandler | null = null;
let ttsLimiterRedis: RateLimitRequestHandler | null = null;

// 3. Background Initializer
// We check periodically until Redis is ready, then create the limiters ONCE.
// This prevents creating them "inside a request handler", which causes the crash.
const initRedisLimiters = () => {
    if (apiLimiterRedis) return; // Already initialized

    if (redisClient.isReady()) {
        try {
            apiLimiterRedis = createRedisLimiter(API_MAX, API_WINDOW, 'API');
            searchLimiterRedis = createRedisLimiter(SEARCH_MAX, SEARCH_WINDOW, 'Search');
            ttsLimiterRedis = createRedisLimiter(TTS_MAX, TTS_WINDOW, 'Audio');
            
            if (apiLimiterRedis) {
                logger.info("✅ Redis Rate Limiters Initialized (Background)");
            }
        } catch (e) {
            // Keep trying on next interval
        }
    }
};

// Start checking for Redis readiness
const initInterval = setInterval(() => {
    if (redisClient.isReady()) {
        initRedisLimiters();
        // Once initialized, stop checking
        if (apiLimiterRedis) clearInterval(initInterval);
    }
}, 5000); // Check every 5 seconds

// --- EXPORTED MIDDLEWARE ---
// These functions delegate to the active limiter (Redis or Memory)

export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (apiLimiterRedis) return apiLimiterRedis(req, res, next);
    return apiLimiterMemory(req, res, next);
};

export const searchLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (searchLimiterRedis) return searchLimiterRedis(req, res, next);
    return searchLimiterMemory(req, res, next);
};

export const ttsLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (ttsLimiterRedis) return ttsLimiterRedis(req, res, next);
    return ttsLimiterMemory(req, res, next);
};
