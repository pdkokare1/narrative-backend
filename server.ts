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
import redisClient, { initRedis } from './utils/redisClient';

// Services & Jobs
import scheduler from './jobs/scheduler';
import queueManager from './jobs/queueManager'; 
import { errorHandler } from './middleware/errorMiddleware';
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService'; 

// Middleware
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
import jobRoutes from './routes/jobRoutes';

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

// --- CORS Configuration ---
// Allows defining origins in ENV or defaults to known domains
const defaultOrigins = [
    'https://thegamut.in', 
    'https://www.thegamut.in', 
    'https://api.thegamut.in',
    'http://localhost:3000'
];

const envOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
const allowedOrigins = [...defaultOrigins, ...envOrigins];

app.use(cors({
  origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) !== -1) {
          callback(null, true);
      } else {
          logger.warn(`🚫 CORS Blocked: ${origin}`);
          callback(new Error('Not allowed by CORS'));
      }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

// --- 3. Firebase Init ---
try {
  if (config.firebase.serviceAccount) {
    const serviceAccount = JSON.parse(config.firebase.serviceAccount);
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

// Protected Routes
app.use('/api/profile', checkAppCheck, checkAuth, profileRoutes);
app.use('/api/activity', checkAppCheck, checkAuth, activityRoutes);

// Job/Admin Routes (Manual Triggers)
app.use('/api/jobs', jobRoutes); 

// Main Article Routes
app.use('/api', articleRoutes); 

// --- 6. Error Handling ---
app.use(errorHandler);

// --- 7. Database & Server Start ---
const startServer = async () => {
    try {
        await initRedis();

        if (config.mongoUri) {
            await mongoose.connect(config.mongoUri);
            logger.info('MongoDB Connected');
        } else {
            throw new Error("MongoDB URI missing in config");
        }

        await Promise.all([
            emergencyService.initializeEmergencyContacts(),
            gatekeeperService.initialize()
        ]);
        
        scheduler.init();

        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`Server running on http://${HOST}:${PORT}`);
        });

        // --- Graceful Shutdown Logic ---
        const gracefulShutdown = async () => {
            logger.info('🛑 Received Kill Signal, shutting down gracefully...');
            
            // 1. Close HTTP Server (Stop accepting new requests)
            server.close(async () => {
                logger.info('Http server closed.');
                
                try {
                    // 2. Stop Background Jobs (Wait for current job to finish)
                    await queueManager.shutdown();

                    // 3. Close Redis
                    await redisClient.quit();

                    // 4. Close Mongo
                    await mongoose.connection.close(false);
                    logger.info('MongoDB connection closed.');
                    
                    process.exit(0);
                } catch (err: any) {
                    logger.error(`⚠️ Error during shutdown: ${err.message}`);
                    process.exit(1);
                }
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
