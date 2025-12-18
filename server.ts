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
import redisClient from './utils/redisClient';
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
    // Don't log spammy health checks
    if (req.url !== '/health' && req.url !== '/ping') {
        logger.http(`${req.method} ${req.url}`);
    }
    next();
});

// CHANGED: Use Configurable Trust Proxy Level
app.set('trust proxy', config.trustProxyLevel);

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

// LIGHTWEIGHT Health Check (For Load Balancers/Railway)
// Does not check DB/Redis connections to prevent cascading failures
app.get('/ping', (req: Request, res: Response) => { 
    res.status(200).send('OK'); 
});

// DEEP Health Check (For Debugging/Status Page)
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
    if (error instanceof Error) {
        logger.error(`Firebase Admin Init Error: ${error.message}`);
    } else {
        logger.error('Firebase Admin Init Error: Unknown error');
    }
}

// --- 6. Global Rate Limiter ---
// Applied to the main API route
app.use('/api/v1/', apiLimiter); 

// --- 7. Mount Routes ---
app.use('/share', shareRoutes); 
// CHANGED: Versioned API Route
app.use('/api/v1', apiRouter);
// Fallback for older clients (Optional - remove if not needed)
app.use('/api', apiRouter);

// --- 8. Error Handling ---
app.use(errorHandler);

// --- 9. Database & Server Start ---
const startServer = async () => {
    try {
        logger.info('🚀 Starting Server Initialization...');

        // 1. Start HTTP Server IMMEDIATELY
        // This ensures Railway Health Check passes even if DB is slow to connect.
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Server running on http://${HOST}:${PORT} (Accepting connections)`);
        });

        // 2. Register Graceful Shutdown
        registerShutdownHandler('API Server', [
            // Stop accepting new HTTP connections
            () => new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else {
                        logger.info('Http server closed.');
                        resolve();
                    }
                });
            }),
            // Stop DB and Queue
            async () => { await dbLoader.disconnect(); },
            async () => { await queueManager.shutdown(); }
        ]);

        // 3. Connect to Infrastructure (Async/Non-blocking)
        // If this fails, the app stays up but returns 503 for data requests, 
        // which is better than a crash loop.
        logger.info('⏳ Connecting to Database & Queue...');
        dbLoader.connect()
            .then(async () => {
                 // Initialize Queue only after DB/Redis is ready
                 await queueManager.initialize();
                 logger.info('✨ Infrastructure Fully Initialized');
            })
            .catch((err) => {
                logger.error(`❌ Infrastructure Connection Failed: ${err.message}`);
                // Optional: process.exit(1) if you want to force restart
            });

    } catch (err) {
        if (err instanceof Error) {
            logger.error(`❌ Critical Startup Error: ${err.message}`);
        } else {
            logger.error('❌ Critical Startup Error: Unknown error');
        }
        process.exit(1);
    }
};

startServer();

export default app;
