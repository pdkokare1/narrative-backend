// server.js (FINAL SECURE)
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

// --- DEBUG: Log every request ---
app.use((req, res, next) => {
    console.log(`📥 [REQUEST] ${req.method} ${req.url}`);
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
    console.log('✅ Firebase Admin SDK Initialized');
  }
} catch (error) {
  console.error('❌ Firebase Admin Init Error:', error.message);
}

// Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, 
  standardHeaders: true, 
  legacyHeaders: false, 
});
app.use('/api/', apiLimiter); 

// Security Middleware (Defined but not mounted yet)
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
    console.warn('⚠️ App Check Error:', err.message);
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
    console.warn('⚠️ Auth Error:', error.code, error.message);
    res.status(403);
    throw new Error('Forbidden: Invalid or expired token');
  }
};

// --- MOUNT PUBLIC ROUTES FIRST (No Auth Required) ---
app.use('/api/assets', assetGenRoutes); 

// --- MOUNT SECURE ROUTES (Auth Required) ---
app.use('/api/profile', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), profileRoutes);
app.use('/api/activity', (req, res, next) => checkAppCheck(req, res, () => checkAuth(req, res, next)), activityRoutes);
// For now, let's keep article/emergency routes open or lightly protected if needed
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

cron.schedule('*/30 * * * *', () => { 
    console.log('⏰ Cron Triggered: Starting News Fetch...');
    newsFetcher.run();
});

if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            console.log('✅ MongoDB Connected');
            await emergencyService.initializeEmergencyContacts();
        })
        .catch(err => console.error("❌ MongoDB Connection Failed:", err.message));
}

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});

module.exports = app;
