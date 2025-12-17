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
  MONGO_POOL_SIZE: z.string().transform(Number).default('10'),
  REDIS_URL: z.string().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // AI & News Keys
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_API_KEY_1: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  
  // Security
  ADMIN_SECRET: z.string().min(5, "Admin secret must be at least 5 chars"),
  CORS_ORIGINS: z.string().default(''), 
  
  // AI Model Configuration
  AI_MODEL_EMBEDDING: z.string().default('text-embedding-004'),
  AI_MODEL_PRO: z.string().default('gemini-2.0-flash'),

  // Firebase
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
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    try {
      const buff = Buffer.from(env.FIREBASE_SERVICE_ACCOUNT, 'base64');
      return JSON.parse(buff.toString('utf-8'));
    } catch (err) {
      logger.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT.');
      return '';
    }
  }
};

// Combine hardcoded trusted origins with dynamic ones
const getCorsOrigins = () => {
  const defaults = [
    env.FRONTEND_URL,
    'https://thegamut.in',
    'https://www.thegamut.in',
    'https://api.thegamut.in',
    'http://localhost:3000'
  ];
  
  if (env.CORS_ORIGINS) {
    const extras = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    defaults.push(...extras);
  }
  
  return Array.from(new Set(defaults)); 
};

// --- CENTRALIZED REDIS CONFIG PARSING ---
const getRedisConfig = () => {
  if (!env.REDIS_URL) return undefined;
  
  try {
      // For redis v4+, the simplest way is to pass the URL directly.
      // This automatically handles username, password, host, and port.
      const config: any = {
          url: env.REDIS_URL
      };

      // Handle rediss:// protocol (TLS) for production (Railway/Render/AWS)
      // We insert these into the 'socket' object which redisClient.ts will merge.
      if (env.REDIS_URL.startsWith('rediss:')) {
          config.socket = {
              tls: true,
              rejectUnauthorized: false 
          };
      }

      return config;
  } catch (e: any) {
      logger.error(`❌ Error parsing Redis URL: ${e.message}`);
      return undefined;
  }
};

const config = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  mongoPoolSize: env.MONGO_POOL_SIZE,
  redisUrl: env.REDIS_URL,
  redisOptions: getRedisConfig(), // Exporting the parsed object
  frontendUrl: env.FRONTEND_URL,
  isProduction: env.NODE_ENV === 'production',
  adminSecret: env.ADMIN_SECRET,
  corsOrigins: getCorsOrigins(),
  
  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    gemini: env.GEMINI_API_KEY || env.GEMINI_API_KEY_1 || '',
    elevenLabs: env.ELEVENLABS_API_KEY || '',
  },
  
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
