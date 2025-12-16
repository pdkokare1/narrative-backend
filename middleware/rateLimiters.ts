// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { CONSTANTS } from '../utils/constants';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

// Helper to create store
const createRedisStore = () => {
  const client = redisClient.getClient();
  if (client && redisClient.isReady()) {
    return new RedisStore({
      // @ts-ignore - Types for redis v4 and rate-limit-redis sometimes conflict slightly, but this is valid
      sendCommand: (...args: string[]) => client.sendCommand(args),
    });
  }
  // Fallback to undefined (memory store) if Redis isn't ready
  return undefined;
};

export const apiLimiter = rateLimit({
  windowMs: CONSTANTS.RATE_LIMIT.WINDOW_MS,
  max: CONSTANTS.RATE_LIMIT.API_MAX_REQUESTS,
  standardHeaders: true, 
  legacyHeaders: false, 
  store: createRedisStore(),
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
  store: createRedisStore(),
  message: { error: 'Audio generation limit reached. Please wait a while.' },
  handler: (req, res, next, options) => {
    logger.warn(`Rate Limit Exceeded (TTS): ${req.ip}`);
    res.status(options.statusCode).send(options.message);
  }
});
