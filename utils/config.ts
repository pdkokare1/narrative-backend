// utils/config.ts
import dotenv from 'dotenv';
import { z } from 'zod';
import logger from './logger';

dotenv.config();

// Define the schema for our environment variables
const envSchema = z.object({
  PORT: z.string().transform(Number).default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Database & Cache
  MONGODB_URI: z.string().url(),
  REDIS_URL: z.string().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // AI & News Keys
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_API_KEY_1: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  
  // AI Model Configuration (Centralized Control)
  AI_MODEL_EMBEDDING: z.string().default('text-embedding-004'),
  AI_MODEL_PRO: z.string().default('gemini-2.0-flash'),

  // Firebase
  // Accepts JSON string OR Base64 encoded JSON (better for some env vars)
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  
  // URLs
  FRONTEND_URL: z.string().url().default('https://thegamut.in'),
});

// Parse and validate
const parseConfig = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    logger.error('❌ Invalid Environment Configuration:');
    result.error.issues.forEach((issue) => {
      logger.error(`   -> ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
};

const env = parseConfig();

// Helper to parse Firebase Config safely
const getFirebaseConfig = () => {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return '';
  try {
    // Try parsing as JSON first
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    try {
      // If that fails, try decoding from Base64
      const buff = Buffer.from(env.FIREBASE_SERVICE_ACCOUNT, 'base64');
      return JSON.parse(buff.toString('utf-8'));
    } catch (err) {
      logger.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT. Check if it is valid JSON or Base64.');
      return '';
    }
  }
};

const config = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  redisUrl: env.REDIS_URL,
  frontendUrl: env.FRONTEND_URL,
  isProduction: env.NODE_ENV === 'production',
  
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    gemini: env.GEMINI_API_KEY || env.GEMINI_API_KEY_1 || '',
    elevenLabs: env.ELEVENLABS_API_KEY || '',
  },
  
  // New Centralized AI Config
  aiModels: {
    embedding: env.AI_MODEL_EMBEDDING,
    pro: env.AI_MODEL_PRO,
  },

  firebase: {
    serviceAccount: getFirebaseConfig(),
  }
};

logger.info('✅ Configuration Validated & Loaded');

export default config;
