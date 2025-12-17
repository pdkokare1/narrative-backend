// server.ts
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';

// Config & Utils
import config from './utils/config';
import logger from './utils/logger';
import redisClient from './utils/redisClient';
import dbLoader from './utils/dbLoader';
import { initFirebase } from './utils/firebaseInit';
import { registerShutdownHandler } from './utils/shutdownHandler';

// Services & Middleware
import emergencyService from './services/emergencyService';
import gatekeeperService from './services/gatekeeperService'; 
import { errorHandler } from './middleware/errorMiddleware';
import { apiLimiter } from './middleware/rateLimiters';

// Routes
import apiRouter from './routes/index'; 
import shareRoutes from './routes/shareRoutes'; 

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
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck', 'x-admin-secret'],
  credentials: true
}));

app.use(express.json({ limit: '200kb' }));

// --- 4. System Routes ---
app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

app.get('/health', async (req: Request, res: Response) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'UP' : 'DOWN';
    const redisStatus = redisClient.isReady() ? 'UP' : 'DOWN';
    
    // Always return 200 if the web server is running
    res.status(200).json({ 
        status: 'OK', 
        mongo: mongoStatus, 
        redis: redisStatus 
    });
});

// --- 5. Initialize Firebase (Centralized) ---
initFirebase();

// --- 6. Global Rate Limiter ---
app.use('/api/', apiLimiter); 

// --- 7. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api', apiRouter);

// --- 8. Error Handling ---
app.use(errorHandler);

// --- 9. Database & Server Start ---
const startServer = async () => {
    try {
        logger.info('🚀 Starting Server Initialization...');

        // 1. Start HTTP Server IMMEDIATELY (Fixes Deployment Timeouts)
        const PORT = config.port || 3001;
        const HOST = '0.0.0.0'; 

        const server = app.listen(Number(PORT), HOST, () => {
            logger.info(`✅ Server running on http://${HOST}:${PORT}`);
        });

        // 2. Unified Database & Redis Connection (Background)
        await dbLoader.connect();

        // 3. Initialize Critical Services (Lightweight)
        (async () => {
            try {
                logger.info('⏳ Initializing API Services...');
                
                await Promise.all([
                    emergencyService.initializeEmergencyContacts(),
                    gatekeeperService.initialize()
                ]);
                logger.info('✨ API Services Ready');
            } catch (bgError: any) {
                logger.error(`⚠️ Service Init Warning: ${bgError.message}`);
            }
        })();

        // --- Graceful Shutdown (Centralized) ---
        registerShutdownHandler('API Server', [
            async () => {
                return new Promise<void>((resolve, reject) => {
                    server.close((err) => {
                        if (err) {
                            logger.error(`Error closing HTTP server: ${err.message}`);
                            reject(err);
                        } else {
                            logger.info('Http server closed.');
                            resolve();
                        }
                    });
                });
            }
        ]);

    } catch (err: any) {
        logger.error(`❌ Critical Startup Error: ${err.message}`);
        process.exit(1);
    }
};

startServer();

export default app;
