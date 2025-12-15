// server.ts
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cron from 'node-cron';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import * as admin from 'firebase-admin';

// Load environment variables
dotenv.config();

// Import local modules
import queueManager from './jobs/queueManager';
import { errorHandler } from './middleware/errorMiddleware';
import logger from './utils/logger';
import emergencyService from './services/emergencyService';

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

// --- 1. Structured Request Logging ---
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
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT as string);
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
  windowMs: 15 * 60 * 1000, // 15 minutes
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

// 1. Daytime Schedule (5 AM to 10:30 PM): Every 30 mins
cron.schedule('*/30 5-22 * * *', async () => { 
    logger.info('☀️ Daytime Fetch (30m interval)...');
    await queueManager.addFetchJob('cron-day', { source: 'cron-day' });
});

// 2. Night Mode (11 PM to 5 AM): Every 2 Hours
// Runs at 23:00 (11PM), 01:00, 03:00
cron.schedule('0 23,1,3 * * *', async () => {
    logger.info('🌙 Night Mode Fetch (2h interval)...');
    await queueManager.addFetchJob('cron-night', { source: 'cron-night' });
});

// Database Connection
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            logger.info('MongoDB Connected');
            await emergencyService.initializeEmergencyContacts();
        })
        .catch((err: any) => logger.error(`MongoDB Connection Failed: ${err.message}`));
}

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(Number(PORT), HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`);
});

export default app;
