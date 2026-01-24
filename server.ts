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
import { registerShutdownHandler } from './utils/shutdownHandler';

// Services & Middleware
import { errorHandler } from './middleware/errorMiddleware';
import { apiLimiter } from './middleware/rateLimiters';

// Routes
import apiRouter from './routes/index'; 
import shareRoutes from './routes/shareRoutes'; 
import analyticsRoutes from './routes/analyticsRoutes'; // <--- NEW IMPORT

const app = express();

// --- 1. Trust Proxy (Critical for Railway/Vercel) ---
app.set('trust proxy', config.trustProxyLevel);

// --- 2. Request Logging ---
app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url !== '/health' && req.url !== '/ping') {
        logger.http(`${req.method} ${req.url}`);
    }
    next();
});

// --- 3. Security Middleware ---
app.disable('x-powered-by');

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: config.csp
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

// SECURITY: Reduced limit to prevent DoS (was 200kb)
app.use(express.json({ limit: '10kb' }));

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
// FIX: Mount share routes at BOTH root and /api to handle different URL constructions
app.use('/share', shareRoutes); 
app.use('/api/share', shareRoutes);

// NEW: Analytics Routes (Mounted before generic API router to avoid conflicts)
app.use('/api/analytics', analyticsRoutes); 
app.use('/api/v1/analytics', analyticsRoutes);

app.use('/api/v1', apiRouter);
// Fallback
app.use('/api', apiRouter);

// --- 9. Error Handling ---
app.use(errorHandler);

// --- 10. Database & Server Start ---
const startServer = async () => {
    try {
        logger.info('🚀 Starting API Server Initialization...');

        // 1. Connect to Infrastructure (DB & Redis)
        await dbLoader.connect();

        // 2. Start HTTP Server
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Web Server running on http://${HOST}:${PORT}`);
        });

        // Note: Worker/Queue initialization is now handled in workerEntry.ts
        // This ensures Web and Worker roles can scale independently.

        // 3. Register Graceful Shutdown
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
            async () => { await dbLoader.disconnect(); }
        ]);

    } catch (err) {
        logger.error(`❌ Critical Startup Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        process.exit(1);
    }
};

startServer();

export default app;
