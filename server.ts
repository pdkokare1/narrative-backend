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

// --- 1. Trust Proxy (Critical for Railway/Vercel) ---
// Must be set BEFORE rate limiters or logging that relies on IPs
app.set('trust proxy', config.trustProxyLevel);

// --- 2. Request Logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url !== '/health' && req.url !== '/ping') {
        logger.http(`${req.method} ${req.url}`);
    }
    next();
});

// --- 3. Security Middleware ---
// SECURITY: Hide Express signature
app.disable('x-powered-by');

// SECURITY: Strict Content Security Policy
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: config.csp // Load strict CSP from config
}));

app.use(compression());
app.use(mongoSanitize());
app.use(hpp());

// --- 4. CORS Configuration ---
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck', 'x-admin-secret'],
  credentials: true
}));

app.use(express.json({ limit: '200kb' }));

// --- 5. System Routes ---
app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

app.get('/ping', (req: Request, res: Response) => { 
    res.status(200).send('OK'); 
});

app.get('/health', async (req: Request, res: Response) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'UP' : 'DOWN';
    const redisStatus = redisClient.isReady() ? 'UP' : 'DOWN';
    
    const status = (mongoStatus === 'UP' && redisStatus === 'UP') ? 200 : 503;

    res.status(status).json({ 
        status: status === 200 ? 'OK' : 'DEGRADED', 
        mongo: mongoStatus, 
        redis: redisStatus 
    });
});

// --- 6. Firebase Init ---
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

// --- 7. Global Rate Limiter ---
app.use('/api/v1/', apiLimiter); 

// --- 8. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api/v1', apiRouter);
// Fallback
app.use('/api', apiRouter);

// --- 9. Error Handling ---
app.use(errorHandler);

// --- 10. Database & Server Start ---
const startServer = async () => {
    try {
        logger.info('🚀 Starting Server Initialization...');

        // 1. Connect to Infrastructure (DB & Redis)
        await dbLoader.connect();

        // 2. Start HTTP Server
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Server running on http://${HOST}:${PORT}`);
        });

        // 3. Initialize Queue (Only if needed by this instance)
        // In a perfect microservices world, this would be in workerEntry.ts
        // But for now, we keep it here to ensure jobs run on the main instance if no worker is present.
        await queueManager.initialize();
        logger.info('✨ Infrastructure Fully Initialized');

        // 4. Register Graceful Shutdown
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
            async () => { await queueManager.shutdown(); },
            async () => { await dbLoader.disconnect(); }
        ]);

    } catch (err) {
        logger.error(`❌ Critical Startup Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        process.exit(1);
    }
};

startServer();

export default app;
