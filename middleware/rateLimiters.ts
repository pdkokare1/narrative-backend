// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

const keyGenerator = (req: Request | any): string => {
    if (req.user && req.user.uid) {
        return `limiter:${req.user.uid}`;
    }
    return req.ip || 'unknown-ip';
};

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

const createRedisLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    const client = redisClient.getClient();
    if (!client) return null;

    try {
        // @ts-ignore - Explicitly cast sendCommand to satisfy RedisStore
        const store = new RedisStore({
            // @ts-ignore
            sendCommand: async (...args: string[]) => {
               try {
                   // Ensure client is still open
                   if(!client.isOpen) return null;
                   return await client.sendCommand(args);
               } catch(e) {
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

// --- Singleton Limiters ---
const apiLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
const ttsLimiterMemory = createMemoryLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');

let apiLimiterRedis: RateLimitRequestHandler | null = null;
let ttsLimiterRedis: RateLimitRequestHandler | null = null;

// --- Dynamic Middleware Wrapper ---
export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        if (!apiLimiterRedis) {
            apiLimiterRedis = createRedisLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
        }
        if (apiLimiterRedis) {
            return apiLimiterRedis(req, res, next);
        }
    }
    return apiLimiterMemory(req, res, next);
};

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
