// server.js (Modularized & Enhanced)
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
const clusteringService = require('./services/clusteringService'); // NEW SERVICE

// --- Models ---
const Profile = require('./models/profileModel');
const ActivityLog = require('./models/activityLogModel');
const Article = require('./models/articleModel'); // NEW IMPORT

// --- Helper Functions ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Initialize Firebase Admin ---
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set.');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK Initialized');
} catch (error) {
  console.error('❌ Firebase Admin Init Error:', error.message);
}

const app = express();

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
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

// --- Apply Middleware ---
app.use('/api/', checkAppCheck); 
app.use('/api/', checkAuth);

// --- Background Fetch Logic (Now uses Clustering Service) ---
let isFetchRunning = false;

app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    return res.status(429).json({ message: 'Fetch process already running. Please wait.' });
  }
  isFetchRunning = true;
  geminiService.isRateLimited = false;
  
  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting in background.', timestamp: new Date().toISOString() });

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Manual fetch background process finished.');
     });
});

async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, skipped_junk: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews(); 
    stats.fetched = rawArticles.length;
    
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched, ending cycle.");
      return stats;
    }

    for (const article of rawArticles) {
        try {
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++;
                continue;
            }

            // Deduplication (24h window)
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const exists = await Article.findOne({
              $or: [
                { url: article.url },
                {
                  headline: article.title,
                  source: article.source?.name,
                  publishedAt: { $gte: oneDayAgo }
                }
              ]
            }, { _id: 1 }).lean();

            if (exists) {
                stats.skipped_duplicate++;
                continue;
            }

            // --- 1. Generate Embedding (The "Vector") ---
            // We combine title + description for a rich vector
            const textToEmbed = `${article.title}. ${article.description}`;
            const embedding = await geminiService.createEmbedding(textToEmbed);

            // --- 2. Analyze Content ---
            console.log(`🤖 Analyzing: ${article.title.substring(0, 50)}...`);
            const analysis = await geminiService.analyzeArticle(article);

            if (analysis.isJunk) {
                stats.skipped_junk++;
                continue;
            }
            
            const newArticleData = {
              headline: article.title,
              summary: analysis.summary || 'Summary unavailable',
              source: article.source?.name || 'Unknown Source',
              category: analysis.category || 'General',
              politicalLean: analysis.politicalLean,
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
              analysisType: analysis.analysisType || 'Full',
              sentiment: analysis.sentiment || 'Neutral',
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
              analysisVersion: Article.schema.path('analysisVersion').defaultValue,
              
              // --- Save Embedding ---
              embedding: embedding || []
            };
            
            // --- 3. Assign Cluster ID (Using Smart Service) ---
            newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);

            // --- 4. Save to DB ---
            await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved: ${newArticleData.headline.substring(0, 40)}... (Cluster: ${newArticleData.clusterId})`);

        } catch (error) {
            console.error(`❌ Error processing article: ${error.message}`);
            stats.errors++;
        }
        
        // Rate Limit Pause
        if (geminiService.isRateLimited) {
          console.log('🐌 Rate-limit active. Pausing for 2s...');
          await sleep(2000); 
        }

    } // End loop

    const duration = ((Date.now() - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Cycle finished in ${duration}s. Processed: ${stats.processed}. Errors: ${stats.errors}.`);
    return stats;

  } catch (error) {
    console.error('❌ CRITICAL Error during news fetch:', error.message);
  }
}

// --- Scheduled Tasks ---
cron.schedule('*/30 * * * *', () => {
  if (isFetchRunning) return;
  isFetchRunning = true;
  geminiService.isRateLimited = false;
  fetchAndAnalyzeNews().finally(() => { isFetchRunning = false; });
});

cron.schedule('0 2 * * *', async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
    console.log(`🗑️ Daily Cleanup: Deleted ${result.deletedCount} articles.`);
  } catch (error) {
    console.error('❌ Cleanup Error:', error.message);
  }
});

// --- Routes (Reduced for brevity - Controllers to be added later) ---

// GET /api/profile/me
app.get('/api/profile/me', async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.user.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles')
      .lean();
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.status(200).json(profile);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// ... (Other routes: /api/profile, /api/activity/*, /api/stats, etc. keep existing logic until Controller Refactor)

// GET /api/articles (Smart Feed)
app.get('/api/articles', async (req, res, next) => {
  try {
    const filters = {
      category: req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null,
      lean: req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null,
      region: req.query.region && req.query.region !== 'All' ? String(req.query.region) : null,
      articleType: req.query.articleType && req.query.articleType !== 'All Types' ? String(req.query.articleType) : null,
      quality: req.query.quality,
      sort: String(req.query.sort || 'Latest First'),
      limit: Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50),
      offset: Math.max(parseInt(req.query.offset) || 0, 0),
    };

    const matchStage = {};
    if (filters.category) matchStage.category = filters.category;
    if (filters.lean) matchStage.politicalLean = filters.lean;
    if (filters.region) matchStage.country = filters.region;
    
    if (filters.articleType === 'Hard News') matchStage.analysisType = 'Full';
    else if (filters.articleType === 'Opinion & Reviews') matchStage.analysisType = 'SentimentOnly';

    if (filters.quality && matchStage.analysisType !== 'SentimentOnly') {
        matchStage.analysisType = 'Full';
        if (filters.quality.includes('0-59')) matchStage.trustScore = { $lt: 60 };
        else {
            const range = filters.quality.match(/(\d+)-(\d+)/);
            if (range) matchStage.trustScore = { $gte: parseInt(range[1]), $lt: parseInt(range[2]) + 1 };
        }
    }

    let sortStage = { publishedAt: -1, createdAt: -1 };
    let postGroupSortStage = { "latestArticle.publishedAt": -1 }; 
    if (filters.sort === 'Highest Quality') { sortStage = { trustScore: -1 }; postGroupSortStage = { "latestArticle.trustScore": -1 }; }
    else if (filters.sort === 'Most Covered') { postGroupSortStage = { clusterCount: -1 }; }
    else if (filters.sort === 'Lowest Bias') { sortStage = { biasScore: 1 }; postGroupSortStage = { "latestArticle.biasScore": 1 }; }

    const aggregation = [
      { $match: matchStage },
      { $sort: sortStage },
      { $group: { _id: { $ifNull: [ "$clusterId", "$_id" ] }, latestArticle: { $first: '$$ROOT' }, clusterCount: { $sum: 1 } } },
      { $addFields: { "latestArticle.clusterCount": "$clusterCount" } },
      { $replaceRoot: { newRoot: '$latestArticle' } },
      { $sort: postGroupSortStage },
      { $facet: { articles: [{ $skip: filters.offset }, { $limit: filters.limit }], pagination: [{ $count: 'total' }] } }
    ];

    const results = await Article.aggregate(aggregation).allowDiskUse(true);
    res.status(200).json({ articles: results[0]?.articles || [], pagination: { total: results[0]?.pagination[0]?.total || 0 } });

  } catch (error) {
    next(error);
  }
});

// ... (Keep other existing routes like save/unsave, cluster fetch, stats, etc.) ...
// Note: For brevity in this response, I am assuming you will keep the other endpoints (save, stats, cluster) 
// exactly as they were in the previous server.js, just ensuring they use the imported 'Article' model.

// Database Connection
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('✅ MongoDB Connected'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
