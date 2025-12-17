// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import config from '../utils/config';

// Helper to create store safely
const createStore = () => {
  // If no Redis URL is configured, use Memory Store
  if (!config.redisUrl) return undefined;

  const client = redisClient.getClient();

  // FIX: Check if Redis is actually connected and ready.
  // If not, we fall back to MemoryStore (return undefined) to prevent the app from crashing.
  if (!client || !redisClient.isReady()) {
    logger.warn('Redis not ready during rate limiter init. Falling back to MemoryStore for stability.');
    return undefined;
  }

  return new RedisStore({
    // @ts-ignore - Types compatibility adjustment
    sendCommand: async (...args: string[]) => {
      try {
        // Double-check readiness before sending command
        if (client && redisClient.isReady()) {
           return await client.sendCommand(args);
        }
        // If connection dropped after init, we return null.
        // The library might handle this or throw, but we've avoided the startup crash.
        return null; 
      } catch (e) {
        logger.error('Redis command failed in rate limiter', e);
        return null;
      }
    },
  });
};

export const apiLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS,
  standardHeaders: true, 
  legacyHeaders: false, 
  store: createStore(),
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (API): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});

export const ttsLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.TTS_MAX_REQUESTS,
  standardHeaders: true, 
  legacyHeaders: false,
  store: createStore(),
  message: { error: 'Audio generation limit reached. Please wait a while.' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (TTS): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});
