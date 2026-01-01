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
  MONGODB_READ_URI: z.string().url().optional(),
  MONGO_POOL_SIZE: z.string().transform(Number).default('10'),
  
  REDIS_URL: z.string().optional(),
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

  // AI & News Keys (Now supports JSON arrays in env vars)
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_KEYS: z.string().optional(), // JSON Array string
  
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_KEYS: z.string().optional(), // JSON Array string
  
  GNEWS_API_KEY: z.string().optional(),
  GNEWS_KEYS: z.string().optional(), // JSON Array string

  // AI Performance
  AI_CONCURRENCY: z.string().transform(Number).default('5'),
  
  // Security
  ADMIN_SECRET: z.string().min(32, "Admin secret must be at least 32 chars long"),
  ADMIN_UIDS: z.string().optional(), // JSON Array or Comma Separated
  CORS_ORIGINS: z.string().default(''), 
  
  // Trust Proxy Configuration
  TRUST_PROXY_LVL: z.string().transform(Number).default('1'),
  
  // Feature Flags
  ENABLE_APP_CHECK: z.enum(['true', 'false']).default('true'),
  
  // AI Model Configuration
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

// Helper: Scan environment for API keys (Robust JSON support)
const extractApiKeys = (prefix: string): string[] => {
    const keys: string[] = [];
    
    // 1. Check for JSON list (e.g. GEMINI_KEYS=["key1", "key2"])
    const jsonKeys = process.env[`${prefix}_KEYS`];
    if (jsonKeys) {
        try {
            const parsed = JSON.parse(jsonKeys);
            if (Array.isArray(parsed)) {
                parsed.forEach(k => { if(typeof k === 'string' && k.trim()) keys.push(k.trim()); });
            }
        } catch(e) { 
            logger.warn(`⚠️ Could not parse ${prefix}_KEYS as JSON. Checking single key.`);
        }
    }

    // 2. Check for Standard Single Key if list is empty
    if (keys.length === 0) {
        const defaultKey = process.env[`${prefix}_API_KEY`]?.trim();
        if (defaultKey) keys.push(defaultKey);
    }
    
    // Logging for debugging (masked)
    if (keys.length > 0) {
        logger.info(`✅ Loaded ${keys.length} keys for ${prefix}`);
    } else {
        logger.warn(`⚠️ No keys found for ${prefix}. Services may fail.`);
    }

    return keys;
};

// Helper: Parse Admin UIDs safely
const getAdminUids = (): string[] => {
    if (!env.ADMIN_UIDS) return [];
    try {
        // Try JSON first
        if (env.ADMIN_UIDS.startsWith('[')) {
            return JSON.parse(env.ADMIN_UIDS);
        }
        // Fallback to comma-separated
        return env.ADMIN_UIDS.split(',').map(s => s.trim()).filter(Boolean);
    } catch (e) {
        logger.error('❌ Failed to parse ADMIN_UIDS');
        return [];
    }
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
  mongoReadUri: env.MONGODB_READ_URI || env.MONGODB_URI,
  mongoPoolSize: env.MONGO_POOL_SIZE,
  redisUrl: env.REDIS_URL,
  redisOptions: getRedisConfig(),
  bullMQConnection: getBullMQConfig(),
  frontendUrl: env.FRONTEND_URL,
  isProduction: env.NODE_ENV === 'production',
  adminSecret: env.ADMIN_SECRET,
  adminUids: getAdminUids(), // Dynamic loading
  corsOrigins: getCorsOrigins(),
  trustProxyLevel: env.TRUST_PROXY_LVL, 
  
  enableAppCheck: env.ENABLE_APP_CHECK === 'true',

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
    gemini: extractApiKeys('GEMINI'), 
    elevenLabs: extractApiKeys('ELEVENLABS'),
    gnews: extractApiKeys('GNEWS'),
  },
  
  aiModels: {
    embedding: env.AI_MODEL_EMBEDDING,
    pro: env.AI_MODEL_PRO,
    fast: env.AI_MODEL_FAST,
  },

  firebase: {
    serviceAccount: getFirebaseConfig(),
  },
  
  csp: {
      directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://apis.google.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://lh3.googleusercontent.com"],
          connectSrc: ["'self'", "https://api.thegamut.in", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'", "https://res.cloudinary.com"],
          frameSrc: ["'none'"],
      }
  }
};

logger.info('✅ Configuration Validated & Loaded');

export default config;
