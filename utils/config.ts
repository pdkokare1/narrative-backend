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
  REDIS_URL: z.string().optional(), // Optional but recommended

  // Cloudinary (Required)
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // AI & News Keys
  // We check for at least one Gemini key
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_API_KEY_1: z.string().optional(),
  
  ELEVENLABS_API_KEY: z.string().optional(),

  // Firebase
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
});

// Parse and validate
const parseConfig = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    logger.error('❌ Invalid Environment Configuration:');
    result.error.issues.forEach((issue) => {
      logger.error(`   -> ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1); // Stop server if config is bad
  }
  return result.data;
};

const env = parseConfig();

// Export the structured config object
const config = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  redisUrl: env.REDIS_URL,
  
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    // Logic to pick whichever key is available
    gemini: env.GEMINI_API_KEY || env.GEMINI_API_KEY_1 || '',
    elevenLabs: env.ELEVENLABS_API_KEY || '',
  },

  firebase: {
    serviceAccount: env.FIREBASE_SERVICE_ACCOUNT || '',
  }
};

logger.info('✅ Configuration Validated & Loaded');

export default config;
