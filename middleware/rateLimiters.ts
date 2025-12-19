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
const createRedisLimiter = (maxRequests: number, windowMs: number, type: string) => {
    try {
        const store = new RedisStore({
            // @ts-expect-error - RedisStore safe wrapping
            sendCommand: async (...args: string[]) => {
                try {
                   const client = redisClient.getClient();
                   if(!client || !client.isOpen) return null;
                   return await client.sendCommand(args);
                } catch(e) {
                   return null;
                }
            },
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

// --- CONFIGURATION ---
// 1. General API (Feed, Profile, etc.) - Fast
const API_WINDOW = 15 * 60 * 1000; // 15 Minutes
const API_MAX = 150; 

// 2. Search API - Expensive
const SEARCH_WINDOW = 1 * 60 * 1000; // 1 Minute
const SEARCH_MAX = 30; // 30 searches per minute is plenty for humans, blocks bots

// 3. Audio Gen - Very Expensive ($$$)
const TTS_WINDOW = 15 * 60 * 1000; // 15 Minutes
const TTS_MAX = 20;

// --- SINGLETON INITIALIZATION ---

// Memory Backups
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
        if (!apiLimiterRedis) apiLimiterRedis = createRedisLimiter(API_MAX, API_WINDOW, 'API');
        if (apiLimiterRedis) return apiLimiterRedis(req, res, next);
    }
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
