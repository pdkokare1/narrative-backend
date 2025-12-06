// server.js (FINAL v3.0 - Modular & Clean)
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

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService'); 
const clusteringService = require('./services/clusteringService'); 

// --- Models ---
const Article = require('./models/articleModel');

// --- Routes ---
const profileRoutes = require('./routes/profileRoutes');
const activityRoutes = require('./routes/activityRoutes');
const articleRoutes = require('./routes/articleRoutes');

const app = express();

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
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
// This connects the files you just created
app.use('/api/profile', profileRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api', articleRoutes); 


// ================= SYSTEM / BACKGROUND JOBS =================

// --- Background Logic (Parallelized) ---
let isFetchRunning = false;

// Manual Trigger Endpoint
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) return res.status(429).json({ message: 'Running' });
  isFetchRunning = true;
  geminiService.isRateLimited = false;
  res.status(202).json({ message: 'Started' });
  fetchAndAnalyzeNews().finally(() => { isFetchRunning = false; });
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAndAnalyzeNews() {
  console.log('🔄 Fetching news...');
  try {
    const rawArticles = await newsService.fetchNews(); 
    if (rawArticles.length === 0) return;

    // --- PARALLEL PROCESSING (Batch Size 3) ---
    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        console.log(`⚡ Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Safety buffer for rate limits
        if (geminiService.isRateLimited) await sleep(5000); 
        else await sleep(1000); 
    }
    console.log('✅ Batch processing complete.');

  } catch (error) {
    console.error('❌ Fetch Error:', error.message);
  }
}

// Extracted Helper for Parallelism
async function processSingleArticle(article) {
    try {
        if (!article?.url || !article?.title) return;
        
        // Quick existence check
        const exists = await Article.findOne({ url: article.url }, { _id: 1 });
        if (exists) return;

        const textToEmbed = `${article.title}. ${article.description}`;
        
        // Analyze with Gemini
        const analysis = await geminiService.analyzeArticle(article);
        if (analysis.isJunk) return;

        // Generate Embedding
        const embedding = await geminiService.createEmbedding(textToEmbed);

        const newArticleData = {
            headline: article.title,
            summary: analysis.summary,
            source: article.source?.name,
            category: analysis.category,
            politicalLean: analysis.politicalLean,
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
            analysisType: analysis.analysisType,
            sentiment: analysis.sentiment,
            biasScore: analysis.biasScore, 
            biasLabel: analysis.biasLabel,
            biasComponents: analysis.biasComponents || {},
            credibilityScore: analysis.credibilityScore, 
            credibilityGrade: analysis.credibilityGrade,
            credibilityComponents: analysis.credibilityComponents || {},
            reliabilityScore: analysis.reliabilityScore, 
            reliabilityGrade: analysis.reliabilityGrade,
            reliabilityComponents: analysis.reliabilityComponents || {},
            trustScore: analysis.trustScore, 
            trustLevel: analysis.trustLevel,
            coverageLeft: analysis.coverageLeft || 0,
            coverageCenter: analysis.coverageCenter || 0,
            coverageRight: analysis.coverageRight || 0,
            clusterTopic: analysis.clusterTopic,
            country: analysis.country,
            primaryNoun: analysis.primaryNoun,
            secondaryNoun: analysis.secondaryNoun,
            keyFindings: analysis.keyFindings || [],
            recommendations: analysis.recommendations || [],
            analysisVersion: '3.0', // Updated version
            embedding: embedding || []
        };
        
        newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        await Article.create(newArticleData);
        console.log(`✅ Saved: ${newArticleData.headline.substring(0, 30)}...`);

    } catch (error) {
        console.error(`❌ Article Error: ${error.message}`);
    }
}

// --- CRON Job (Every 30 mins) ---
cron.schedule('*/30 * * * *', () => { 
    if(!isFetchRunning) { 
        isFetchRunning = true; 
        geminiService.isRateLimited = false; 
        fetchAndAnalyzeNews().finally(() => isFetchRunning = false); 
    } 
});

// --- Server Startup ---
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.error("❌ MongoDB Connection Failed:", err.message));
}

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});

module.exports = app;
