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
  
  // Redis - Primary (Cache/Rate Limits)
  REDIS_URL: z.string().optional(),
  // Redis - Queue (Background Jobs) - Optional, falls back to REDIS_URL
  REDIS_QUEUE_URL: z.string().optional(),

  // Worker Configuration
  WORKER_CONCURRENCY: z.string().transform(Number).default('5'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'), // 15 minutes
  RATE_LIMIT_MAX_API: z.string().transform(Number).default('150'),       
  RATE_LIMIT_MAX_TTS: z.string().transform(Number).default('20'),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // AI & News Keys
  // Removed single string validation for Gemini to allow arrays
  GEMINI_API_KEY: z.string().optional(),
  
  // AI Performance (New)
  AI_CONCURRENCY: z.string().transform(Number).default('5'),
  
  // Security
  ADMIN_SECRET: z.string().min(32, "Admin secret must be at least 32 chars long"),
  ADMIN_UIDS: z.string().optional(),
  CORS_ORIGINS: z.string().default(''), 
  
  // Trust Proxy Configuration
  TRUST_PROXY_LVL: z.string().transform(Number).default('1'),
  
  // AI Model Configuration - STRICT 2.5 DEFAULTS
  AI_MODEL_EMBEDDING: z.string().default('text-embedding-004'),
  AI_MODEL_PRO: z.string().default('gemini-2.5-pro'),
  AI_MODEL_FAST: z.string().default('gemini-2.5-flash'),

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

// Helper: Scan environment for API keys
const extractApiKeys = (prefix: string): string[] => {
    const keys: string[] = [];
    
    // 1. Check for JSON list
    const jsonKeys = process.env[`${prefix}_KEYS`];
    if (jsonKeys) {
        try {
            const parsed = JSON.parse(jsonKeys);
            if (Array.isArray(parsed)) return parsed;
        } catch(e) { /* ignore */ }
    }

    // 2. Check for Standard Single Key
    const defaultKey = process.env[`${prefix}_API_KEY`]?.trim();
    if (defaultKey) keys.push(defaultKey);

    // 3. Check for Numbered Keys (1-20)
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
      const decoded = buff.toString('utf-8');
      return JSON.parse(decoded);
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

// --- REDIS CONFIG (CACHE) ---
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

// --- BULLMQ CONFIG (QUEUE) ---
const getBullMQConfig = () => {
    const targetUrl = env.REDIS_QUEUE_URL || env.REDIS_URL;
    
    if (!targetUrl) return undefined;
    try {
        const parsed = new URL(targetUrl);
        return {
            host: parsed.hostname,
            port: Number(parsed.port),
            username: parsed.username || undefined,
            password: parsed.password || undefined,
            tls: targetUrl.startsWith('rediss:') ? { rejectUnauthorized: false } : undefined
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
  adminUids: [
    ...(env.ADMIN_UIDS ? env.ADMIN_UIDS.split(',').map(id => id.trim()) : []),
    'z5uKireLhcffRWvocrrYMZaLbZw1'
  ],
  corsOrigins: getCorsOrigins(),
  trustProxyLevel: env.TRUST_PROXY_LVL, 
  
  worker: {
      concurrency: env.WORKER_CONCURRENCY
  },
  
  ai: {
      concurrency: env.AI_CONCURRENCY
  },
  
  rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxApi: env.RATE_LIMIT_MAX_API,
      maxTts: env.RATE_LIMIT_MAX_TTS
  },

  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  },

  keys: {
    // FIX: Updated to extract ALL Gemini keys, not just the first one
    gemini: extractApiKeys('GEMINI'), 
    elevenLabs: extractApiKeys('ELEVENLABS'),
    gnews: extractApiKeys('GNEWS'),
    newsApi: extractApiKeys('NEWS_API')
  },
  
  aiModels: {
    embedding: env.AI_MODEL_EMBEDDING,
    pro: env.AI_MODEL_PRO,
    fast: env.AI_MODEL_FAST,
  },

  firebase: {
    serviceAccount: getFirebaseConfig(),
  }
};

logger.info('✅ Configuration Validated & Loaded');

export default config;
