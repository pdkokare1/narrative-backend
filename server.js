// server.js (UPDATED v2.14 - Worker Startup Delay Fix)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Services & Worker ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService');
// Import the Model definition FIRST
const Article = require('./articleModel'); 
// The worker functions are required lazily inside the cron block


// --- Firebase Admin Setup (Unchanged) ---
const admin = require('firebase-admin');
try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      })
    });
    console.log('✅ Firebase Admin SDK Initialized from Environment Variables');
  } else {
    // Fallback: This is less secure but keeps local dev simple if envs aren't set
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.warn('⚠️ Firebase Admin SDK Initialized from local file (serviceAccountKey.json). Use ENV vars for production!');
  }
} catch (error) {
  console.error('❌ Firebase Admin Init Error. Check credentials and serviceAccountKey.json:', error.message);
}
// --- END Firebase Admin Setup ---


const app = express();

// --- Middleware (Unchanged) ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter (Unchanged) ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Auth Middleware (Unchanged) ---
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.warn('⚠️ Auth Error:', error.code, error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
  }
};

// Apply Limiter and Auth to all /api/ routes
app.use('/api/', apiLimiter, checkAuth);


// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
      console.error('❌ MongoDB Connection Error:', err.message);
      process.exit(1); 
  });

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB runtime error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected.');
});
// --- End DB Connection ---


// --- API Routes (Unchanged) ---
// (All API routes here are unchanged)

// GET / - Health Check (Unprotected)
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Gamut API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      'Asynchronous AI Worker (v2.14)',
      'Stable Deployment Startup',
      'PDF-Based Trust Score (OTS = sqrt(UCS*URS))',
      'AI-Powered Event Clustering',
      'Junk/Ad Article Filtering',
      'Review/Opinion Filter',
      'Env-Based Firebase Admin Auth'
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});

app.get('/api/articles', async (req, res, next) => { /* ... (Logic remains the same) ... */
    try {
        const category = req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null;
        const lean = req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null;
        const quality = req.query.quality && req.query.quality !== 'All Quality Levels' ? String(req.query.quality) : null;
        const sort = String(req.query.sort || 'Latest First');
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);

        let query = {
            clusterTopic: { $exists: true, $ne: null },
        };
        if (category) query.category = category;
        if (lean) query.politicalLean = lean;

        if (quality) {
          if (quality === 'Review / Opinion') {
              query.analysisType = 'SentimentOnly';
          } else {
            query.analysisType = 'Full';
            query.trustScore = query.trustScore || {};
            const rangeMatch = quality.match(/(\d+)-(\d+)/);
            if (rangeMatch) {
                query.trustScore.$gte = parseInt(rangeMatch[1]);
                query.trustScore.$lt = parseInt(rangeMatch[2]) + 1;
            } else if (quality.includes('0-59')) {
                 query.trustScore = { $lt: 60 };
            }
          }
        } else {
            query.analysisType = { $ne: 'Pending' };
        }

        let sortOption = { publishedAt: -1, createdAt: -1 };
        switch(sort) {
            case 'Highest Quality': sortOption = { trustScore: -1, publishedAt: -1 }; break;
            case 'Most Covered': sortOption = { clusterId: 1, trustScore: -1, publishedAt: -1 }; break;
            case 'Lowest Bias': sortOption = { biasScore: 1, publishedAt: -1 }; break;
        }

        const [articles, total] = await Promise.all([
          Article.find(query).sort(sortOption).limit(limit).skip(offset).lean(),
          Article.countDocuments(query)
        ]);

        res.status(200).json({
          articles,
          pagination: { total, limit, offset, hasMore: (offset + articles.length) < total }
        });

      } catch (error) {
        console.error('❌ Error in GET /api/articles:', error.message);
        next(error);
      }
});

app.get('/api/articles/:id', async (req, res, next) => { /* ... (Logic remains the same) ... */
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid article ID format' });
        }
        const article = await Article.findById(id).lean();
        if (!article) return res.status(404).json({ error: 'Article not found' });
        res.status(200).json(article);
    } catch (error) {
        console.error(`❌ Error in GET /api/articles/${req.params.id}:`, error.message);
        next(error);
    }
});

app.get('/api/cluster/:clusterId', async (req, res, next) => { /* ... (Logic remains the same) ... */
    try {
        const clusterIdNum = parseInt(req.params.clusterId);
        if (isNaN(clusterIdNum)) return res.status(400).json({ error: 'Invalid cluster ID' });

        const articles = await Article.find({ clusterId: clusterIdNum, analysisType: 'Full' })
          .sort({ trustScore: -1, publishedAt: -1 })
          .lean();

        const grouped = articles.reduce((acc, article) => {
          const lean = article.politicalLean;
          if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
          else if (lean === 'Center') acc.center.push(article);
          else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
          return acc;
        }, { left: [], center: [], right: [] });

        const totalArticles = articles.length;
        const calculateAverage = (field) => totalArticles > 0
          ? Math.round(articles.reduce((sum, a) => sum + (a[field] || 0), 0) / totalArticles)
          : 0;
        const stats = {
          totalArticles, leftCount: grouped.left.length, centerCount: grouped.center.length, rightCount: grouped.right.length,
          averageBias: calculateAverage('biasScore'), averageTrust: calculateAverage('trustScore')
        };

        res.status(200).json({ ...grouped, stats });
      } catch (error) {
        console.error(`❌ Error in GET /api/cluster/${req.params.clusterId}:`, error.message);
        next(error);
      }
});

app.get('/api/stats', async (req, res, next) => { /* ... (Logic remains the same) ... */
    try {
        const [statsData, leanDistribution, categoryDistribution] = await Promise.all([
            Article.aggregate([
                { $facet: {
                    totalArticles: [{ $match: { clusterTopic: { $exists: true } } }, { $count: "count" }],
                    sources: [{ $match: { source: { $ne: null }}}, { $group: { _id: "$source" } }, { $count: "count" }],
                    categories: [{ $match: { category: { $ne: null }}}, { $group: { _id: "$category" } }, { $count: "count" }],
                    avgBiasResult: [ { $match: { analysisType: 'Full', biasScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$biasScore' } } } ],
                    avgTrustResult: [ { $match: { analysisType: 'Full', trustScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$trustScore' } } } ]
                }}
            ]).allowDiskUse(true),
            Article.aggregate([ { $match: { analysisType: 'Full' } }, { $group: { _id: '$politicalLean', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
            Article.aggregate([ { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
        ]);

        const results = statsData[0] || {};
        const formatDistribution = (dist) => dist.reduce((acc, item) => { acc[item._id || 'Unknown'] = item.count; return acc; }, {});

        res.status(200).json({
          totalArticles: results.totalArticles?.[0]?.count || 0,
          totalSources: results.sources?.[0]?.count || 0,
          totalCategories: results.categories?.[0]?.count || 0,
          averageBias: Math.round(results.avgBiasResult?.[0]?.avg || 0),
          averageTrust: Math.round(results.avgTrustResult?.[0]?.avg || 0),
          leanDistribution: formatDistribution(leanDistribution),
          categoryDistribution: formatDistribution(categoryDistribution),
          lastUpdated: new Date().toISOString()
        });

      } catch (error) {
        console.error('❌ Error in GET /api/stats:', error.message);
        next(error);
      }
});

app.get('/api/stats/keys', (req, res, next) => { /* ... (Logic remains the same) ... */
    try {
        const geminiStats = geminiService.getStatistics ? geminiService.getStatistics() : { error: "Stats unavailable" };
        const newsStats = newsService.getStatistics ? newsService.getStatistics() : { error: "Stats unavailable" };
        res.status(200).json({ gemini: geminiStats, news: newsStats, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('❌ Error in GET /api/stats/keys:', error.message);
        next(error);
    }
});


// POST /api/fetch-news - Trigger background news fetch (PROTECTED)
let isFetchRunning = false;
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch trigger ignored: Fetch already running.');
    return res.status(429).json({ message: 'Fetch process already running. Please wait.' });
  }
  console.log('📰 Manual fetch triggered via API...');
  isFetchRunning = true;

  res.status(202).json({ message: 'Fetch acknowledged. Raw article ingestion starting background.', timestamp: new Date().toISOString() });

  fetchRawArticles()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Manual raw article fetch process finished.');
     });
});


// --- Core Function: FAST Fetch & Ingestion (Unchanged) ---
async function fetchRawArticles() {
  console.log('🔄 Starting FAST fetchRawArticles cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews();
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched, ending cycle.");
      return stats;
    }

    const allUrls = rawArticles.map(a => a.url);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const existingArticles = await Article.find({
        $or: [
            { url: { $in: allUrls } },
            ...rawArticles.map(a => ({
                headline: a.title,
                source: a.source?.name,
                publishedAt: { $gte: oneDayAgo }
            }))
        ]
    }, { url: 1, headline: 1, source: 1 }).lean();

    const existingMap = new Map();
    existingArticles.forEach(a => {
        if (a.url) existingMap.set(a.url, true);
        if (a.headline && a.source) existingMap.set(`${a.headline}::${a.source}`, true);
    });

    const articlesToInsert = [];
    for (const article of rawArticles) {
        if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
            stats.skipped_invalid++;
            continue;
        }

        if (existingMap.has(article.url) || existingMap.has(`${article.title}::${article.source?.name}`)) {
            stats.skipped_duplicate++;
            continue;
        }

        articlesToInsert.push({
            headline: article.title,
            summary: article.description,
            source: article.source?.name || 'Unknown Source',
            category: 'General',
            politicalLean: 'Pending',
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
            analysisType: 'Pending',
            sentiment: 'Neutral',
            analysisVersion: Article.schema.path('analysisVersion').defaultValue
        });
    }

    if (articlesToInsert.length > 0) {
        const result = await Article.insertMany(articlesToInsert, { ordered: false })
            .catch(err => {
                if (err.code !== 11000) throw err;
                return err.result;
            });
        
        stats.processed = result?.insertedCount || 0;
        console.log(`✅ Bulk Ingested ${stats.processed} new raw articles into queue.`);
    }

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Raw fetch cycle finished in ${duration}s: ${stats.processed} ingested, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_invalid} invalid.\n`);
    return stats;

  } catch (error) {
    console.error('❌ CRITICAL Error during raw news fetch stage:', error.message);
    stats.errors = 1;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error.`);
  }
}

// --- NEW: AI Worker Status ---
let isAIWorkerRunning = false;
let processedCount = 0;

// ------------------------------------------------------------------
// --- CRON JOBS ARE NOW INITIALIZED INSIDE mongoose.connection.once('open', ...) ---
// ------------------------------------------------------------------


// --- Error Handling & Server Startup ---

app.use((req, res, next) => {
  res.status(404).json({ error: `Not Found - Cannot ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('💥 Global Error Handler:', err);
  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(statusCode).json({
    error: {
      message: message,
    }
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// --- NEW: Start Server ONLY after Mongoose is ready ---
mongoose.connection.once('open', () => {
    console.log("Database connection established. Starting server.");
    
    // 1. Start Express Server
    app.listen(PORT, HOST, () => {
      console.log(`\n🚀 Server listening on host ${HOST}, port ${PORT}`);
      console.log(`🔗 Health Check: http://localhost:${PORT}/`);
      console.log(`API available at /api`);
    });

    // 2. Delay CRON STARTUP (5 seconds) to ensure Render marks deployment as successful
    setTimeout(() => {
        console.log("⏰ Initializing scheduled tasks after 5 seconds startup delay...");
        
        // --- Auto-fetch raw articles every 30 minutes (FAST) ---
        cron.schedule('*/30 * * * *', () => {
          if (isFetchRunning) {
            console.log('⏰ Cron: Skipping scheduled fetch - previous job still active.');
            return;
          }
          console.log('⏰ Cron: Triggering scheduled raw news fetch...');
          isFetchRunning = true;

          fetchRawArticles()
            .catch(err => { console.error('❌ CRITICAL Error during scheduled fetch:', err.message); })
            .finally(() => {
                isFetchRunning = false;
                console.log('🟢 Scheduled raw article fetch process complete.');
             });
        });

        // --- Auto-run the AI Processor Worker every 45 seconds (Rate-Limited Worker) ---
        cron.schedule('*/45 * * * * *', async () => {
            const articleProcessor = require('./articleProcessor'); 

            if (isAIWorkerRunning) {
                return;
            }

            isAIWorkerRunning = true;
            let didProcess = false;

            try {
                // console.log('🧠 Worker: Checking for unanalyzed articles...');
                didProcess = await articleProcessor.processNextArticle();

                if (didProcess) {
                    processedCount++;
                    // console.log(`🧠 Worker: Article processed. Total: ${processedCount} since start.`);
                }
            } catch (error) {
                console.error('❌ CRITICAL Error during AI worker run:', error.message);
            } finally {
                isAIWorkerRunning = false;
            }
        });

        // --- Auto-cleanup daily at 2 AM server time (Unchanged) ---
        cron.schedule('0 2 * * *', async () => {
          console.log('🧹 Cron: Triggering daily article cleanup...');
          try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
            console.log(`🗑️ Cleanup successful: Deleted ${result.deletedCount} articles older than 7 days (batch limit 5000).`);
          } catch (error) {
            console.error('❌ CRITICAL Error during scheduled cleanup:', error.message);
          }
        });

        console.log(`🕒 Raw Article Ingestion scheduled: Every 30 minutes (FAST)`);
        console.log(`🧠 AI Article Processor scheduled: Every 45 seconds (Rate-Limited Worker)`);
        console.log(`🗑️ Cleanup scheduled: Daily at 2 AM`);

    }, 90000); // 90-second delay for cron job initialization

});
// --- End Server Startup ---


// --- Graceful Shutdown (Unchanged) ---
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} received. Initiating graceful shutdown...`);
  try {
    console.log('🔌 Closing MongoDB connection...');
    await mongoose.connection.close();
    console.log('💾 MongoDB connection closed.');
    console.log('✅ Shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
