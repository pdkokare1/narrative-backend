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

// Services
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
    if (req.url !== '/health') {
        logger.http(`${req.method} ${req.url}`);
    }
    next();
});

app.set('trust proxy', 1);

// --- 2. Security Middleware ---
app.use(helmet({ 
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));

app.use(compression());
app.use(mongoSanitize());
app.use(hpp());

// --- 3. CORS Configuration ---
const allowedOrigins = [
    config.frontendUrl,
    'https://thegamut.in', 
    'https://www.thegamut.in', 
    'https://api.thegamut.in',
    'http://localhost:3000'
];

if (process.env.CORS_ORIGINS) {
    allowedOrigins.push(...process.env.CORS_ORIGINS.split(','));
}

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
  credentials: true
}));

app.use(express.json({ limit: '200kb' }));

// --- 4. System Routes ---
app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

app.get('/health', async (req: Request, res: Response) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'UP' : 'DOWN';
    // Use optional chaining for safety if redisClient is initializing
    const redisStatus = redisClient.getClient()?.isOpen ? 'UP' : 'DOWN';
    
    if (mongoStatus === 'UP' && redisStatus === 'UP') {
        res.status(200).json({ status: 'OK', mongo: mongoStatus, redis: redisStatus });
    } else {
        res.status(503).json({ status: 'ERROR', mongo: mongoStatus, redis: redisStatus });
    }
});

// --- 5. Firebase Init ---
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

// --- 6. Global Rate Limiter ---
app.use('/api/', apiLimiter); 

// --- 7. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api/assets', assetGenRoutes); 
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsLimiter, ttsRoutes); 
app.use('/api/migration', migrationRoutes); 
app.use('/api/cluster', clusterRoutes);

// Protected Routes
app.use('/api/profile', checkAppCheck, checkAuth, profileRoutes);
app.use('/api/activity', checkAppCheck, checkAuth, activityRoutes);

// Job/Admin Routes
app.use('/api/jobs', jobRoutes); 

// Main Article Routes
app.use('/api', articleRoutes); 

// --- 8. Error Handling ---
app.use(errorHandler);

// --- 9. Database & Server Start ---
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
        
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`Server running on http://${HOST}:${PORT}`);
        });

        // --- Graceful Shutdown ---
        const gracefulShutdown = async () => {
            logger.info('🛑 Received Kill Signal, shutting down gracefully...');
            setTimeout(() => {
                logger.error('🛑 Force Shutdown (Timeout)');
                process.exit(1);
            }, 10000);

            server.close(async () => {
                logger.info('Http server closed.');
                try {
                    // Note: We do NOT shutdown queueManager here because
                    // the Worker is running in a different process (workerEntry.ts).
                    // We only close the Redis Client.
                    await redisClient.quit();
                    await mongoose.connection.close(false);
                    logger.info('✅ Resources released. Exiting.');
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
