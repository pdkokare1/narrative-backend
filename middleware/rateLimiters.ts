// middleware/rateLimiters.ts
import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true, 
  legacyHeaders: false, 
  message: { error: 'Too many requests, please try again later.' }
});

export const ttsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Strict limit for expensive AI audio generation
  standardHeaders: true, 
  legacyHeaders: false,
  message: { error: 'Audio generation limit reached. Please wait a while.' }
});
