// utils/config.ts
import dotenv from 'dotenv';
import { z } from 'zod';
import logger from './logger';
import { URL } from 'url';

dotenv.config();

// Define the schema for our environment variables
const envSchema = z.object({
  PORT: z.string().transform(Number).default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Database & Cache
  MONGODB_URI: z.string().url(),
  MONGO_POOL_SIZE: z.string().transform(Number).default('10'),
  REDIS_URL: z.string().optional(),

  // Worker Configuration
  WORKER_CONCURRENCY: z.string().transform(Number).default('5'),

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

// Helper: Scan environment for numbered API keys (e.g., GNEWS_API_KEY_1, _2...)
const extractApiKeys = (prefix: string): string[] => {
    const keys: string[] = [];
    
    // 1. Check default key
    const defaultKey = process.env[`${prefix}_API_KEY`]?.trim();
    if (defaultKey) keys.push(defaultKey);

    // 2. Scan numbered keys (1 to 20)
    for (let i = 1; i <= 20; i++) {
        const key = process.env[`${prefix}_API_KEY_${i}`]?.trim();
        if (key && !keys.includes(key)) {
            keys.push(key);
        }
    }
    return keys;
};

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

// --- REDIS CONFIG ---
const getRedisConfig = () => {
  if (!env.REDIS_URL) return undefined;
  
  try {
      const config: any = { url: env.REDIS_URL };
      if (env.REDIS_URL.startsWith('rediss:')) {
          config.socket = { tls: true, rejectUnauthorized: false };
      }
      return config;
  } catch (e: any) {
      return undefined;
  }
};

// --- BULLMQ CONFIG ---
const getBullMQConfig = () => {
    if (!env.REDIS_URL) return undefined;
    try {
        const parsed = new URL(env.REDIS_URL);
        return {
            host: parsed.hostname,
            port: Number(parsed.port),
            username: parsed.username || undefined,
            password: parsed.password || undefined,
            tls: env.REDIS_URL.startsWith('rediss:') ? { rejectUnauthorized: false } : undefined
        };
    } catch (e) {
        logger.error("❌ Failed to parse Redis URL for BullMQ");
        return undefined;
    }
};

const config = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  mongoPoolSize: env.MONGO_POOL_SIZE,
  redisUrl: env.REDIS_URL,
  redisOptions: getRedisConfig(),
  bullMQConnection: getBullMQConfig(),
  frontendUrl: env.FRONTEND_URL,
  isProduction: env.NODE_ENV === 'production',
  adminSecret: env.ADMIN_SECRET,
  corsOrigins: getCorsOrigins(),
  
  worker: {
      concurrency: env.WORKER_CONCURRENCY
  },

  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    gemini: env.GEMINI_API_KEY || env.GEMINI_API_KEY_1 || '',
    elevenLabs: env.ELEVENLABS_API_KEY || '',
    // Arrays of keys extracted from env
    gnews: extractApiKeys('GNEWS'),
    newsApi: extractApiKeys('NEWS_API')
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
