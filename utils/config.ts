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

  // Firebase
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  
  // URLs & Secrets
  FRONTEND_URL: z.string().url().default('https://thegamut.in'),
  ADMIN_SECRET: z.string().optional(), // For protecting manual jobs
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

const config = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  redisUrl: env.REDIS_URL,
  frontendUrl: env.FRONTEND_URL,
  adminSecret: env.ADMIN_SECRET || 'change_this_secret_locally', 
  
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    gemini: env.GEMINI_API_KEY || env.GEMINI_API_KEY_1 || '',
    elevenLabs: env.ELEVENLABS_API_KEY || '',
  },

  firebase: {
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || '',
  }
};

logger.info('✅ Configuration Validated & Loaded');

export default config;
