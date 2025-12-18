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
import redisClient, { initRedis } from './utils/redisClient'; // ✅ Added initRedis import
import dbLoader from './utils/dbLoader';
import queueManager from './jobs/queueManager';
import { registerShutdownHandler } from './utils/shutdownHandler';

// Services & Middleware
import { errorHandler } from './middleware/errorMiddleware';
import { apiLimiter } from './middleware/rateLimiters';

// Routes
import apiRouter from './routes/index'; 
import shareRoutes from './routes/shareRoutes'; 

const app = express();

// --- 1. Request Logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url !== '/health' && req.url !== '/ping') {
        logger.http(`${req.method} ${req.url}`);
    }
    next();
});

// CHANGED: Use Configurable Trust Proxy Level (Recommended for Railway)
// '1' indicates the app is behind 1 reverse proxy (Railway's load balancer)
app.set('trust proxy', 1);

// --- 2. Security Middleware ---
app.use(helmet({ 
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));

app.use(compression());
app.use(mongoSanitize());
app.use(hpp());

// --- 3. CORS Configuration ---
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck', 'x-admin-secret'],
  credentials: true
}));

app.use(express.json({ limit: '200kb' }));

// --- 4. System Routes ---
app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

app.get('/ping', (req: Request, res: Response) => { 
    res.status(200).send('OK'); 
});

app.get('/health', async (req: Request, res: Response) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'UP' : 'DOWN';
    const redisStatus = redisClient.isReady() ? 'UP' : 'DOWN';
    
    // Return 503 if critical services are down so monitoring tools know
    const status = (mongoStatus === 'UP' && redisStatus === 'UP') ? 200 : 503;

    res.status(status).json({ 
        status: status === 200 ? 'OK' : 'DEGRADED', 
        mongo: mongoStatus, 
        redis: redisStatus 
    });
});

// --- 5. Firebase Init ---
try {
  if (config.firebase.serviceAccount) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(config.firebase.serviceAccount)
      });
      logger.info('Firebase Admin SDK Initialized');
    }
  }
} catch (error) {
    logger.error(`Firebase Admin Init Error: ${error instanceof Error ? error.message : 'Unknown'}`);
}

// --- 6. Global Rate Limiter ---
app.use('/api/v1/', apiLimiter); 

// --- 7. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api/v1', apiRouter);
// Fallback
app.use('/api', apiRouter);

// --- 8. Error Handling ---
app.use(errorHandler);

// --- 9. Database & Server Start ---
const startServer = async () => {
    try {
        logger.info('🚀 Starting Server Initialization...');

        // 1. Initialize Redis FIRST (Before accepting traffic)
        // This ensures rate limiters work immediately upon startup
        await initRedis();

        // 2. Start HTTP Server
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Server running on http://${HOST}:${PORT}`);
        });

        // 3. Register Graceful Shutdown
        registerShutdownHandler('API Server', [
            // Stop HTTP
            () => new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else {
                        logger.info('Http server closed.');
                        resolve();
                    }
                });
            }),
            // Stop DB, Queue, Redis
            async () => { await dbLoader.disconnect(); },
            async () => { await queueManager.shutdown(); },
            async () => { await redisClient.disconnect(); } // ✅ Close Redis last
        ]);

        // 4. Connect to DB (Non-blocking)
        logger.info('⏳ Connecting to Database...');
        dbLoader.connect()
            .then(async () => {
                 await queueManager.initialize();
                 logger.info('✨ Infrastructure Fully Initialized');
            })
            .catch((err) => {
                logger.error(`❌ Infrastructure Connection Failed: ${err.message}`);
            });

    } catch (err) {
        logger.error(`❌ Critical Startup Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        process.exit(1);
    }
};

startServer();

export default app;
