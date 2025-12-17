// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

// Helper to create store dynamically
// This prevents the "Client Closed" error by fetching the client only when needed
const createRedisStore = () => {
  return new RedisStore({
    // @ts-ignore - Types compatibility adjustment
    sendCommand: async (...args: string[]) => {
      const client = redisClient.getClient();
      
      // Only use Redis if it's actually connected and ready
      if (client && redisClient.isReady()) {
        return client.sendCommand(args);
      }
      
      // If Redis isn't ready, we return null/undefined to force a fallback or handle gracefully
      // Ideally, we want to fail open (allow request) or fail closed (block)
      // For rate limits, throwing here might cause 500s, so we'll log and return nothing
      // which allows the memory fallback inside express-rate-limit if configured, 
      // or simply bypasses redis operations.
      return Promise.resolve(null); 
    },
  });
};

export const apiLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS,
  standardHeaders: true, 
  legacyHeaders: false, 
  store: createRedisStore(),
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => {
    // Optional: Skip rate limiting for your own Frontend if needed
    // return req.hostname === 'thegamut.in'; 
    return false;
  },
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
  store: createRedisStore(),
  message: { error: 'Audio generation limit reached. Please wait a while.' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (TTS): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});
