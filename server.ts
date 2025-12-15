// server.ts
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cron from 'node-cron';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as admin from 'firebase-admin';

// --- 1. Load & Validate Config FIRST ---
import config from './utils/config';
import logger from './utils/logger';

// Import local modules
import queueManager from './jobs/queueManager';
import { errorHandler } from './middleware/errorMiddleware';
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService'; 
import redis from './utils/redisClient'; 

// Import Models
import Article from './models/articleModel';

// Import Routes
import profileRoutes from './routes/profileRoutes';
import activityRoutes from './routes/activityRoutes';
import articleRoutes from './routes/articleRoutes';
import emergencyRoutes from './routes/emergencyRoutes';
import ttsRoutes from './routes/ttsRoutes';
import migrationRoutes from './routes/migrationRoutes';
import assetGenRoutes from './routes/assetGenRoutes';
import shareRoutes from './routes/shareRoutes';
import clusterRoutes from './routes/clusterRoutes'; 

// Extend Express Request interface to include 'user'
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

const app = express();

// --- 2. Request Logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
    logger.http(`${req.method} ${req.url}`);
    next();
});

app.set('trust proxy', 1);
app.use(helmet({ 
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));
app.use(compression());

app.use(cors({
  origin: [
    'https://thegamut.in', 
    'https://www.thegamut.in', 
    'https://api.thegamut.in',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck']
}));

app.use(express.json({ limit: '1mb' }));

app.get('/', (req: Request, res: Response) => { res.status(200).send('OK'); });

// Firebase Init
try {
  if (config.firebase.serviceAccount) {
    const serviceAccount = JSON.parse(config.firebase.serviceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    logger.info('Firebase Admin SDK Initialized');
  }
} catch (error: any) {
  logger.error(`Firebase Admin Init Error: ${error.message}`);
}

// Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000, 
  standardHeaders: true, 
  legacyHeaders: false, 
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter); 

// Security Middleware
const checkAppCheck = async (req: Request, res: Response, next: NextFunction) => {
  const appCheckToken = req.header('X-Firebase-AppCheck');
  if (!appCheckToken) {
      res.status(401);
      throw new Error('Unauthorized: No App Check token.');
  }
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err: any) {
    logger.warn(`App Check Error: ${err.message}`);
    res.status(403);
    throw new Error('Forbidden: Invalid App Check token.');
  }
};

const checkAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
      res.status(401);
      throw new Error('Unauthorized: No token provided');
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    logger.warn(`Auth Error: ${error.code || 'Unknown'} - ${error.message}`);
    res.status(403);
    throw new Error('Forbidden: Invalid or expired token');
  }
};

// --- Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api/assets', assetGenRoutes); 
app.use('/api/profile', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), profileRoutes);
app.use('/api/activity', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), activityRoutes);
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsRoutes); 
app.use('/api/migration', migrationRoutes); 
app.use('/api/cluster', clusterRoutes);
app.use('/api', articleRoutes); 

// --- Jobs Endpoint ---
app.post('/api/fetch-news', async (req: Request, res: Response) => {
  await queueManager.addFetchJob('manual-trigger', { source: 'api' });
  res.status(202).json({ message: 'News fetch job added to queue.' });
});

// --- SAFE SCHEDULING ---
cron.schedule('*/30 5-22 * * *', async () => { 
    logger.info('☀️ Daytime Fetch (30m interval)...');
    await queueManager.addFetchJob('cron-day', { source: 'cron-day' });
});

cron.schedule('0 23,1,3 * * *', async () => {
    logger.info('🌙 Night Mode Fetch (2h interval)...');
    await queueManager.addFetchJob('cron-night', { source: 'cron-night' });
});

cron.schedule('*/30 * * * *', async () => {
    logger.info('📈 Updating Trending Topics Cache...');
    try {
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const results = await Article.aggregate([
            { $match: { publishedAt: { $gte: twoDaysAgo }, clusterTopic: { $exists: true, $ne: null } } },
            { $group: { _id: "$clusterTopic", count: { $sum: 1 }, sampleScore: { $max: "$trustScore" } } },
            { $match: { count: { $gte: 3 } } }, 
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]);
        
        const topics = results.map(r => ({ topic: r._id, count: r.count, score: r.sampleScore }));
        
        // @ts-ignore
        if (redis.isReady()) {
            await redis.set('trending_topics_smart', topics, 3600); 
            logger.info(`✅ Trending Topics Updated (${topics.length} topics)`);
        }
    } catch (err: any) {
        logger.error(`❌ Trending Calc Failed: ${err.message}`);
    }
});

// Database Connection
if (config.mongoUri) {
    mongoose.connect(config.mongoUri)
        .then(async () => {
            logger.info('MongoDB Connected');
            await Promise.all([
                emergencyService.initializeEmergencyContacts(),
                gatekeeperService.initialize()
            ]);
        })
        .catch((err: any) => logger.error(`MongoDB Connection Failed: ${err.message}`));
}

app.use(errorHandler);

const PORT = config.port || 3001;
const HOST = '0.0.0.0'; 

app.listen(Number(PORT), HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`);
});

export default app;
