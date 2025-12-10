// server.js (FINAL v3.4 - With Migration Tools)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Import Firebase Admin ---
const admin = require('firebase-admin');

// --- Import Job Manager ---
const newsFetcher = require('./jobs/newsFetcher');

// --- Routes ---
const profileRoutes = require('./routes/profileRoutes');
const activityRoutes = require('./routes/activityRoutes');
const articleRoutes = require('./routes/articleRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const ttsRoutes = require('./routes/ttsRoutes'); 
const migrationRoutes = require('./routes/migrationRoutes'); // <--- NEW IMPORT

// --- Services ---
const emergencyService = require('./services/emergencyService');

const app = express();

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ 
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow audio loading
}));
app.use(compression());

// --- CORS Config ---
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

// --- 1. HEALTH CHECK ---
app.get('/', (req, res) => {
  res.status(200).send('OK'); 
});

// --- Initialize Firebase Admin ---
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

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, 
  standardHeaders: true, 
  legacyHeaders: false, 
});
app.use('/api/', apiLimiter); 

// --- App Check Middleware ---
const checkAppCheck = async (req, res, next) => {
  const appCheckToken = req.header('X-Firebase-AppCheck');
  if (!appCheckToken) return res.status(401).json({ error: 'Unauthorized: No App Check token.' });
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err) {
    console.warn('⚠️ App Check Error:', err.message);
    return res.status(403).json({ error: 'Forbidden: Invalid App Check token.' });
  }
};

// --- Auth Middleware ---
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.warn('⚠️ Auth Error:', error.code, error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
  }
};

// --- Apply Security Middleware ---
app.use('/api/', checkAppCheck); 
app.use('/api/', checkAuth);

// --- MOUNT ROUTES ---
app.use('/api/profile', profileRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/migration', migrationRoutes); // <--- NEW ROUTE
app.use('/api', articleRoutes); 


// ================= SYSTEM / BACKGROUND JOBS =================

// Manual Trigger Endpoint
app.post('/api/fetch-news', async (req, res) => {
  const started = await newsFetcher.run();
  
  if (!started) {
    return res.status(429).json({ message: 'Job is already running. Please wait.' });
  }
  
  res.status(202).json({ message: 'News fetch job started successfully.' });
});

// --- CRON Job (Every 30 mins) ---
cron.schedule('*/30 * * * *', () => { 
    console.log('⏰ Cron Triggered: Starting News Fetch...');
    newsFetcher.run();
});

// --- Server Startup ---
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            console.log('✅ MongoDB Connected');
            await emergencyService.initializeEmergencyContacts();
        })
        .catch(err => console.error("❌ MongoDB Connection Failed:", err.message));
}

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});

module.exports = app;
