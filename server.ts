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

// --- 0. Global Safety Nets (Must be first) ---
process.on('uncaughtException', (err) => {
    logger.error(`🔥 UNCAUGHT EXCEPTION! Shutting down... ${err.name}: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
    logger.error(`🔥 UNHANDLED REJECTION! ${reason}`);
});

const app = express();
let isReady = false; // Flag to track system readiness

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
  // Cleaned up allowedHeaders (Removed x-admin-secret)
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck'],
  credentials: true
}));

app.use(express.json({ limit: '200kb' }));

// --- 4. System Routes & Health Checks ---
app.get('/', (req: Request, res: Response) => { res.status(200).send('Narrative Backend Running'); });

app.get('/health', async (req: Request, res: Response) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'UP' : 'DOWN';
    const redisStatus = redisClient.isReady() ? 'UP' : 'DOWN';
    
    // Return detailed status, but always 200 if HTTP is working
    res.status(200).json({ 
        status: isReady ? 'OK' : 'INITIALIZING', 
        mongo: mongoStatus, 
        redis: redisStatus 
    });
});

// --- 5. Startup Protection Middleware (The Gate) ---
// Prevents API requests from hitting services before DB is connected
app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isReady && req.path.startsWith('/api')) {
        return res.status(503).json({ 
            success: false,
            message: 'Service Initializing. Please try again in a few seconds.' 
        });
    }
    next();
});

// --- 6. Initialize Firebase (Centralized) ---
initFirebase();

// --- 7. Global Rate Limiter ---
app.use('/api/', apiLimiter); 

// --- 8. Mount Routes ---
app.use('/share', shareRoutes); 
app.use('/api', apiRouter);

// --- 9. Error Handling ---
app.use(errorHandler);

// --- 10. Database & Server Start ---
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

        // 3. Mark System as READY
        isReady = true; 
        logger.info('🔓 API Gate Open: System is now accepting requests.');

        // 4. Initialize Critical Services (Lightweight)
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
                isReady = false; // Close the gate immediately
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
