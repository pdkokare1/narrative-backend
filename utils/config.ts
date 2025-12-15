// utils/config.ts
import dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    logger.error(`❌ CRITICAL: Missing Environment Variable: ${key}`);
    process.exit(1); // Stop server immediately to prevent runtime crashes
  }
  return value;
};

const optional = (key: string, fallback: string): string => {
  return process.env[key] || fallback;
};

const config = {
  port: parseInt(optional('PORT', '3001')),
  mongoUri: required('MONGODB_URI'),
  
  // Redis is optional but highly recommended
  redisUrl: optional('REDIS_URL', ''),

  // Cloudinary (Required for Audio)
  cloudinary: {
    cloudName: required('CLOUDINARY_CLOUD_NAME'),
    apiKey: required('CLOUDINARY_API_KEY'),
    apiSecret: required('CLOUDINARY_API_SECRET'),
  },

  // AI & News (KeyManager handles rotation, but we check presence of at least one)
  keys: {
    gemini: process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1,
    elevenLabs: process.env.ELEVENLABS_API_KEY,
  },

  firebase: {
    serviceAccount: optional('FIREBASE_SERVICE_ACCOUNT', ''),
  }
};

// Log successful config load
logger.info('✅ Configuration Loaded Successfully');

export default config;
