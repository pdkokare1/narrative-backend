// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import config from '../utils/config';

// Helper to create store safely
const createStore = () => {
  // If no Redis URL is configured, use Memory Store (return undefined)
  if (!config.redisUrl) return undefined;

  return new RedisStore({
    // @ts-ignore - Types compatibility adjustment
    sendCommand: async (...args: string[]) => {
      const client = redisClient.getClient();
      
      // Only attempt command if Client is connected and ready
      if (client && redisClient.isReady()) {
        try {
            return await client.sendCommand(args);
        } catch (e) {
            // If Redis fails mid-command, swallow error to prevent app crash
            // Rate limiting will simply fail-open for this request
            return null;
        }
      }
      
      // If Redis is not ready, we return null.
      // NOTE: This might make rate limiting ineffective until Redis connects,
      // but it prevents the "Service Unavailable" crash loop.
      return null; 
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
