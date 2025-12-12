// server.js (FINAL SECURE - Structured Logging)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const admin = require('firebase-admin');
const newsFetcher = require('./jobs/newsFetcher');
const { errorHandler } = require('./middleware/errorMiddleware');
const logger = require('./utils/logger'); // <--- NEW: Import Logger

// Routes
const profileRoutes = require('./routes/profileRoutes');
const activityRoutes = require('./routes/activityRoutes');
const articleRoutes = require('./routes/articleRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const ttsRoutes = require('./routes/ttsRoutes'); 
const migrationRoutes = require('./routes/migrationRoutes');
const assetGenRoutes = require('./routes/assetGenRoutes'); 

const emergencyService = require('./services/emergencyService');

const app = express();

// --- 1. Structured Request Logging ---
app.use((req, res, next) => {
    // Log as 'http' level so it's filterable
    logger.http(`${req.method} ${req.url}`);
    next();
});

app.set('trust proxy', 1);
app.use(helmet({ 
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));
app.use(compression());

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

app.get('/', (req, res) => { res.status(200).send('OK'); });

// Firebase Init
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    logger.info('Firebase Admin SDK Initialized');
  }
} catch (error) {
  logger.error(`Firebase Admin Init Error: ${error.message}`);
}

// Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, 
  standardHeaders: true, 
  legacyHeaders: false, 
});
app.use('/api/', apiLimiter); 

// Security Middleware
const checkAppCheck = async (req, res, next) => {
  const appCheckToken = req.header('X-Firebase-AppCheck');
  if (!appCheckToken) {
      res.status(401);
      throw new Error('Unauthorized: No App Check token.');
  }
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err) {
    logger.warn(`App Check Error: ${err.message}`);
    res.status(403);
    throw new Error('Forbidden: Invalid App Check token.');
  }
};

const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
      res.status(401);
      throw new Error('Unauthorized: No token provided');
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    logger.warn(`Auth Error: ${error.code || 'Unknown'} - ${error.message}`);
    res.status(403);
    throw new Error('Forbidden: Invalid or expired token');
  }
};

// --- Mount Routes ---
app.use('/api/assets', assetGenRoutes); 
app.use('/api/profile', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), profileRoutes);
app.use('/api/activity', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), activityRoutes);
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsRoutes); 
app.use('/api/migration', migrationRoutes); 
app.use('/api', articleRoutes); 

// Jobs
app.post('/api/fetch-news', async (req, res) => {
  const started = await newsFetcher.run();
  if (!started) return res.status(429).json({ message: 'Job is already running.' });
  res.status(202).json({ message: 'Job started.' });
});

// Cron Schedule
cron.schedule('*/30 * * * *', () => { 
    logger.info('⏰ Cron Triggered: Starting News Fetch...');
    newsFetcher.run();
});

// Database Connection
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            logger.info('MongoDB Connected');
            await emergencyService.initializeEmergencyContacts();
        })
        .catch(err => logger.error(`MongoDB Connection Failed: ${err.message}`));
}

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
    logger.info(`Server running on http://${HOST}:${PORT}`);
});

module.exports = app;
