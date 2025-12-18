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

// CHANGED: Use Configurable Trust Proxy Level (Safe for Railway/Heroku)
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
// This must respond 200 OK even if DB is connecting
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

        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        // 1. START HTTP SERVER FIRST (Optimistic Startup)
        // This ensures Health Checks pass immediately, preventing Deployment Timeouts.
        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Server running on http://${HOST}:${PORT}`);
        });

        // 2. Register Graceful Shutdown
        registerShutdownHandler('API Server', [
            () => new Promise<void>((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else {
                        logger.info('Http server closed.');
                        resolve();
                    }
                });
            }),
            async () => { await queueManager.shutdown(); }
        ]);

        // 3. CONNECT SERVICES IN BACKGROUND
        // We do this AFTER listening so the app assumes "Ready" state quickly.
        logger.info('⏳ Connecting to Database & Queue...');
        
        // These can take time without failing the deployment
        await dbLoader.connect(); 
        await queueManager.initialize();

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
