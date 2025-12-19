// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import config from '../utils/config';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

const keyGenerator = (req: Request | any): string => {
    // Check if user is authenticated via authMiddleware
    if (req.user && req.user.uid) {
        return `limiter:${req.user.uid}`;
    }
    // Fallback to IP address
    return req.ip || 'unknown-ip';
};

// --- 1. Memory Limiter (Backup) ---
const createMemoryLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    return rateLimit({
        windowMs: config.rateLimit.windowMs,
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

// --- 2. Redis Limiter (Primary) ---
const createRedisLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
    try {
        const store = new RedisStore({
            // @ts-expect-error - RedisStore expects a specific command signature, but we wrap the v4 client safely
            sendCommand: async (...args: string[]) => {
                try {
                   const client = redisClient.getClient();
                   // If client is missing or not open, return null to trigger error handling
                   if(!client || !client.isOpen) return null;
                   
                   return await client.sendCommand(args);
                } catch(e) {
                   return null;
                }
            },
        });

        return rateLimit({
            windowMs: config.rateLimit.windowMs,
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
// Always create memory limiters as backup
const apiLimiterMemory = createMemoryLimiter(config.rateLimit.maxApi, 'API');
const ttsLimiterMemory = createMemoryLimiter(config.rateLimit.maxTts, 'TTS');

// Redis limiters are created lazily
let apiLimiterRedis: RateLimitRequestHandler | null = null;
let ttsLimiterRedis: RateLimitRequestHandler | null = null;

// --- Dynamic Middleware Wrappers ---
// This logic checks Redis health on EVERY request to decide which limiter to use
export const apiLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        // Init Redis limiter if not exists
        if (!apiLimiterRedis) {
            apiLimiterRedis = createRedisLimiter(config.rateLimit.maxApi, 'API');
        }
        // Use Redis limiter if successfully created
        if (apiLimiterRedis) {
            return apiLimiterRedis(req, res, next);
        }
    }
    // Fallback to Memory
    return apiLimiterMemory(req, res, next);
};

export const ttsLimiter = (req: Request, res: Response, next: NextFunction) => {
    if (redisClient.isReady()) {
        // Init Redis limiter if not exists
        if (!ttsLimiterRedis) {
            ttsLimiterRedis = createRedisLimiter(config.rateLimit.maxTts, 'TTS');
        }
        // Use Redis limiter if successfully created
        if (ttsLimiterRedis) {
            return ttsLimiterRedis(req, res, next);
        }
    }
    // Fallback to Memory
    return ttsLimiterMemory(req, res, next);
};
