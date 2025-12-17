// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

/**
 * LAZY RATE LIMITER WRAPPER
 * * Problem: initializing RedisStore immediately crashes the app if Redis isn't connected yet.
 * Solution: We start with a MemoryStore (safe). We only instantiate RedisStore when 
 * redisClient.isReady() returns true.
 */

// --- 1. Define Fallback (Memory) Limiters ---
const memoryApiLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later. (Mem)' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (Mem-API): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

const memoryTtsLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Audio generation limit reached. Please wait a while. (Mem)' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (Mem-TTS): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

// --- 2. Cache for the Real Redis Limiters ---
let redisApiLimiter: RateLimitRequestHandler | null = null;
let redisTtsLimiter: RateLimitRequestHandler | null = null;

// Helper to create the Redis-backed limiter on the fly
const createRedisLimiter = (maxRequests: number, type: 'API' | 'TTS') => {
  return rateLimit({
    windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      // @ts-ignore
      sendCommand: async (...args: string[]) => {
        try {
          const client = redisClient.getClient();
          if (client && redisClient.isReady()) {
            return await client.sendCommand(args);
          }
          return null;
        } catch (e) {
          logger.error('Redis command failed in rate limiter', e);
          return null;
        }
      },
    }),
    message: { error: type === 'API' ? 'Too many requests, please try again later.' : 'Audio generation limit reached.' },
    handler: (req, res, next, options) => {
      logger.warn(`Rate Limit Exceeded (${type}): ${req.ip}`);
      res.status(options.statusCode).send(options.message);
    }
  });
};

// --- 3. Exported Middlewares (The Switch Logic) ---

export const apiLimiter = (req: any, res: any, next: any) => {
  // If Redis is ready, use (or create) the Redis limiter
  if (redisClient.isReady()) {
    if (!redisApiLimiter) {
      logger.info('⚡ Upgrading API Rate Limiter to Redis Store');
      redisApiLimiter = createRedisLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
    }
    return redisApiLimiter(req, res, next);
  }

  // Otherwise, use Memory fallback
  return memoryApiLimiter(req, res, next);
};

export const ttsLimiter = (req: any, res: any, next: any) => {
  // If Redis is ready, use (or create) the Redis limiter
  if (redisClient.isReady()) {
    if (!redisTtsLimiter) {
      logger.info('⚡ Upgrading TTS Rate Limiter to Redis Store');
      redisTtsLimiter = createRedisLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');
    }
    return redisTtsLimiter(req, res, next);
  }

  // Otherwise, use Memory fallback
  return memoryTtsLimiter(req, res, next);
};
