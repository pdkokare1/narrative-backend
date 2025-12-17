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

  // We intentionally DO NOT check for client connection here immediately.
  // The client connects asynchronously during server startup.
  // We use a dynamic getter in sendCommand to find the client when it's ready.

  return new RedisStore({
    // @ts-ignore - Types compatibility adjustment
    sendCommand: async (...args: string[]) => {
      try {
        const client = redisClient.getClient(); // Fetch the current client instance
        // Check readiness at runtime (when request comes in)
        if (client && redisClient.isReady()) {
           return await client.sendCommand(args);
        }
        // If Redis isn't ready yet, returning null allows express-rate-limit 
        // to handle it (likely pass-through or fail-open depending on config)
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
