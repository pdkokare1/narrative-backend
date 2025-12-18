// middleware/rateLimiters.ts
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import { Request } from 'express';

/**
 * Custom Key Generator:
 * Uses User ID if authenticated, otherwise falls back to IP.
 * This prevents shared IPs (offices, schools) from being blocked by one bad actor.
 */
const keyGenerator = (req: Request | any): string => {
    if (req.user && req.user.uid) {
        return `limiter:${req.user.uid}`;
    }
    return req.ip || 'unknown-ip';
};

// --- 1. Define Fallback (Memory) Limiters ---
const memoryApiLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGenerator,
  message: { error: 'Too many requests, please try again later. (Mem)' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (Mem-API): ${keyGenerator(req)}`);
    res.status(options.statusCode).send(options.message);
  }
});

const memoryTtsLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGenerator,
  message: { error: 'Audio generation limit reached. Please wait a while. (Mem)' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (Mem-TTS): ${keyGenerator(req)}`);
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
    keyGenerator: keyGenerator,
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
      logger.warn(`Rate Limit Exceeded (${type}): ${keyGenerator(req)}`);
      res.status(options.statusCode).send(options.message);
    }
  });
};

// --- 3. Exported Middlewares ---

export const apiLimiter = (req: any, res: any, next: any) => {
  if (redisClient.isReady()) {
    if (!redisApiLimiter) {
      logger.info('⚡ Upgrading API Rate Limiter to Redis Store');
      redisApiLimiter = createRedisLimiter(CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS, 'API');
    }
    return redisApiLimiter(req, res, next);
  }
  return memoryApiLimiter(req, res, next);
};

export const ttsLimiter = (req: any, res: any, next: any) => {
  if (redisClient.isReady()) {
    if (!redisTtsLimiter) {
      logger.info('⚡ Upgrading TTS Rate Limiter to Redis Store');
      redisTtsLimiter = createRedisLimiter(CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS, 'TTS');
    }
    return redisTtsLimiter(req, res, next);
  }
  return memoryTtsLimiter(req, res, next);
};
