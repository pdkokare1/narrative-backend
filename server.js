// server.js (AUTO-MIGRATION, RESTART FIX - TEMPORARY)
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

// --- Services & Models needed for migration ---
const emergencyService = require('./services/emergencyService');
const aiService = require('./services/aiService'); // Needed for the migration
const Article = require('./models/articleModel'); // Needed for the migration

// --- Routes (Keep imports) ---
const profileRoutes = require('./routes/profileRoutes');
const activityRoutes = require('./routes/activityRoutes');
const articleRoutes = require('./routes/articleRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const ttsRoutes = require('./routes/ttsRoutes'); 
const migrationRoutes = require('./routes/migrationRoutes'); 

const app = express();

// --- Middleware (Skipping non-essential config for brevity) ---
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

// --- Auth and Security Middleware (Unchanged) ---
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter); 

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

// --- MOUNT SECURE ROUTES ---
app.use('/api/profile', profileRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/emergency-resources', emergencyRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api', articleRoutes); 


// ================= AUTO-MIGRATION FUNCTION =================

async function runBackfillLoop() {
    console.log('🤖 Starting AUTO-MIGRATION on server startup...');
    const BATCH_SIZE = 10;
    
    // Loop until no un-vectorized articles are left
    while (true) {
        
        const articlesToFix = await Article.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: { $size: 0 } }
            ]
        }).limit(BATCH_SIZE);

        if (articlesToFix.length === 0) {
            console.log('🎉 AUTO-MIGRATION COMPLETE: All articles are optimized.');
            break; // Exit the loop
        }
        
        console.log(`⚡ Processing batch of ${articlesToFix.length}. Remaining estimates: ${await Article.countDocuments({
            $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }]
        })}`);

        let successCount = 0;
        
        for (const article of articlesToFix) {
            try {
                // Wait for a short moment before processing to prevent hitting the rate limit
                await new Promise(resolve => setTimeout(resolve, 300));
                
                const textToEmbed = `${article.headline}. ${article.summary}`;
                const embedding = await aiService.createEmbedding(textToEmbed);

                if (embedding) {
                    article.embedding = embedding;
                    await article.save();
                    successCount++;
                }
            } catch (err) {
                // If AI service fails, log the error and wait longer before retrying the batch
                console.error(`❌ Migration Failure (Could be rate limit or bad key). Waiting 10 seconds before re-checking DB...`);
                await new Promise(resolve => setTimeout(resolve, 10000)); 
                break; // Break the 'for' loop and restart the 'while' loop to fetch a new batch
            }
        }
        
        // Wait 1 second between batches to be polite to the AI API
        await new Promise(resolve => setTimeout(resolve, 1000)); 
    }
}


// ================= SYSTEM / BACKGROUND JOBS =================

app.post('/api/fetch-news', async (req, res) => {
  const started = await newsFetcher.run();
  if (!started) return res.status(429).json({ message: 'Job is already running. Please wait.' });
  res.status(202).json({ message: 'News fetch job started successfully.' });
});

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
            
            // --- CRITICAL: RUN MIGRATION AUTOMATICALLY ---
            runBackfillLoop();
            // ---------------------------------------------
        })
        .catch(err => console.error("❌ MongoDB Connection Failed:", err.message));
}

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});

module.exports = app;
