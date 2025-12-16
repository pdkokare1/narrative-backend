// server.ts
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import * as admin from 'firebase-admin';

// Config & Utils
import config from './utils/config';
import logger from './utils/logger';
import { initRedis } from './utils/redisClient'; // <--- NEW IMPORT

// Services & Jobs
import queueManager from './jobs/queueManager';
import scheduler from './jobs/scheduler';
import { errorHandler } from './middleware/errorMiddleware';
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService'; 

// Middleware (Refactored)
import { checkAuth, checkAppCheck } from './middleware/authMiddleware';
import { apiLimiter, ttsLimiter } from './middleware/rateLimiters';

// Routes
import profileRoutes from './routes/profileRoutes';
import activityRoutes from './routes/activityRoutes';
import articleRoutes from './routes/articleRoutes';
import emergencyRoutes from './routes/emergencyRoutes';
import ttsRoutes from './routes/ttsRoutes';
import migrationRoutes from './routes/migrationRoutes';
import assetGenRoutes from './routes/assetGenRoutes';
import shareRoutes from './routes/shareRoutes';
import clusterRoutes from './routes/clusterRoutes'; 

const app = express();

// --- 1. Request Logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
    logger.http(`${req.method} ${req.url}`);
    next();
});

app.set('trust proxy', 1);

// --- 2. Security Middleware ---
app.use(helmet({ 
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));
app.use(compression());
app.use(mongoSanitize());
app.use(hpp());

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

// --- 3. Firebase Init ---
try {
  if (config.firebase.serviceAccount) {
    const serviceAccount = JSON.parse(config.firebase.serviceAccount);
    // Check if already initialized to avoid hot-reload errors in dev
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      logger.info('Firebase Admin SDK Initialized');
    }
  }
} catch (error: any) {
  logger.error(`Firebase Admin Init Error: ${error.message}`);
}

// --- 4. Global Rate Limiter ---
app.use('/api/', apiLimiter); 

// --- 5. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api/assets', assetGenRoutes); 
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsLimiter, ttsRoutes); 
app.use('/api/migration', migrationRoutes); 
app.use('/api/cluster', clusterRoutes);

// Protected Routes (using the new middleware)
app.use('/api/profile', checkAppCheck, checkAuth, profileRoutes);
app.use('/api/activity', checkAppCheck, checkAuth, activityRoutes);

// Main Article Routes
app.use('/api', articleRoutes); 

// Manual Job Trigger
app.post('/api/fetch-news', async (req: Request, res: Response) => {
  await queueManager.addFetchJob('manual-trigger', { source: 'api' });
  res.status(202).json({ message: 'News fetch job added to queue.' });
});

// --- 6. Database & Server Start ---
const startServer = async () => {
    try {
        // 1. Connect to Redis (Critical for rate limits & dedupe)
        await initRedis();

        // 2. Connect to MongoDB
        if (config.mongoUri) {
            await mongoose.connect(config.mongoUri);
            logger.info('MongoDB Connected');
        } else {
            throw new Error("MongoDB URI missing in config");
        }

        // 3. Initialize Services
        await Promise.all([
            emergencyService.initializeEmergencyContacts(),
            gatekeeperService.initialize()
        ]);
        
        // 4. Start the Scheduler
        scheduler.init();

        // 5. Start Listening
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`Server running on http://${HOST}:${PORT}`);
        });

        // --- Graceful Shutdown ---
        const gracefulShutdown = () => {
            logger.info('🛑 Received Kill Signal, shutting down gracefully...');
            server.close(() => {
                logger.info('Http server closed.');
                mongoose.connection.close(false).then(() => {
                    logger.info('MongoDB connection closed.');
                    process.exit(0);
                });
            });
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

    } catch (err: any) {
        logger.error(`❌ Critical Startup Error: ${err.message}`);
        process.exit(1);
    }
};

startServer();

export default app;
