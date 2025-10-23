// server.js (FINAL v2.5 - Includes 31s delay for free tier)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService'); // Assumes newsService.js has focused fetching

const app = express();

// --- Middleware ---
app.set('trust proxy', 1); // Trust first proxy for rate limiting, etc.
app.use(helmet({ contentSecurityPolicy: false })); // Basic security headers (CSP disabled for simplicity, review if needed)
app.use(compression()); // Gzip compression
app.use(cors()); // Allow frontend requests (Configure origins in production ideally)
app.use(express.json({ limit: '1mb' })); // Parse JSON bodies, limit size

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
});
app.use('/api/', apiLimiter); // Apply limiter specifically to API routes

// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB runtime error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected.');
});

// --- Mongoose Schema ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
  publishedAt: { type: Date, default: Date.now, index: true },
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'] },
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  biasScore: { type: Number, default: 0, min: 0, max: 100 },
  biasLabel: String,
  biasComponents: mongoose.Schema.Types.Mixed,
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 },
  credibilityGrade: String,
  credibilityComponents: mongoose.Schema.Types.Mixed,
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
  reliabilityGrade: String,
  reliabilityComponents: mongoose.Schema.Types.Mixed,
  trustScore: { type: Number, default: 0, min: 0, max: 100 },
  trustLevel: String,
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.5' } // Version bump
}, {
  timestamps: true, // Adds createdAt and updatedAt
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 }); // Added publishedAt
articleSchema.index({ biasScore: 1, publishedAt: -1 }); // Added publishedAt
articleSchema.index({ createdAt: 1 }); // For cleanup

const Article = mongoose.model('Article', articleSchema);

// --- API Routes ---

// GET / - Health Check
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Narrative API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      'Enhanced Bias Detection', 'Credibility & Reliability Scoring', 'Trust Score',
      'Sentiment Analysis', 'Analysis Type (Full/SentimentOnly)', 'Story Clustering',
      'Advanced Filtering', 'Auto-refresh every 30 mins', 'Background Fetch',
      'Focused News Sources (US/IN/World)', 'Reduced Safety Blocking' // Added features
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});

// GET /api/articles - Fetch articles
app.get('/api/articles', async (req, res, next) => {
  try {
    const category = req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null;
    const lean = req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null;
    const quality = req.query.quality && req.query.quality !== 'All Quality Levels' ? String(req.query.quality) : null;
    const minTrust = parseInt(req.query.minTrust);
    const maxBias = parseInt(req.query.maxBias);
    const sort = String(req.query.sort || 'Latest First');
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 200); // Clamp limit 1-200
    const offset = Math.max(parseInt(req.query.offset) || 0, 0); // Ensure offset >= 0

    let query = {};
    if (category) query.category = category;
    if (lean) query.politicalLean = lean;

    if (quality) {
        query.trustScore = query.trustScore || {};
        const rangeMatch = quality.match(/(\d+)-(\d+)/); // Match number ranges like "80-89"
        if (rangeMatch) {
            query.trustScore.$gte = parseInt(rangeMatch[1]);
            query.trustScore.$lt = parseInt(rangeMatch[2]) + 1; // Makes range inclusive (e.g., < 90 for 80-89)
        } else if (quality.includes('0-59')) {
             query.trustScore = { $lt: 60 };
        } // Add other specific non-range quality levels if needed
    }
    if (!isNaN(minTrust)) query.trustScore = { ...query.trustScore, $gte: minTrust };
    if (!isNaN(maxBias)) query.biasScore = { $lte: maxBias };

    let sortOption = { publishedAt: -1, createdAt: -1 }; // Default sort
    switch(sort) {
        case 'Highest Quality': sortOption = { trustScore: -1, publishedAt: -1 }; break;
        case 'Most Covered': sortOption = { clusterId: 1, trustScore: -1, publishedAt: -1 }; break;
        case 'Lowest Bias': sortOption = { biasScore: 1, publishedAt: -1 }; break;
        // Default 'Latest First' is handled by the initial sortOption
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

// GET /api/articles/:id - Fetch single article
app.get('/api/articles/:id', async (req, res, next) => {
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

// GET /api/cluster/:clusterId - Fetch cluster data
app.get('/api/cluster/:clusterId', async (req, res, next) => {
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

// GET /api/stats - Fetch overall stats
app.get('/api/stats', async (req, res, next) => {
  try {
    const [statsData, leanDistribution, categoryDistribution] = await Promise.all([
        Article.aggregate([
            { $facet: {
                totalArticles: [{ $count: "count" }],
                sources: [{ $match: { source: { $ne: null }}}, { $group: { _id: "$source" } }, { $count: "count" }], // Count distinct non-null sources
                categories: [{ $match: { category: { $ne: null }}}, { $group: { _id: "$category" } }, { $count: "count" }], // Count distinct non-null categories
                avgBiasResult: [ { $match: { analysisType: 'Full', biasScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$biasScore' } } } ],
                avgTrustResult: [ { $match: { analysisType: 'Full', trustScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$trustScore' } } } ]
            }}
        ]).allowDiskUse(true),
        Article.aggregate([ { $match: { analysisType: 'Full' } }, { $group: { _id: '$politicalLean', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
        Article.aggregate([ { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
    ]);

    const results = statsData[0] || {}; // Handle empty facet result
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

// GET /api/stats/keys - Fetch API key usage stats
app.get('/api/stats/keys', (req, res, next) => {
  try {
    const geminiStats = geminiService.getStatistics ? geminiService.getStatistics() : { error: "Stats unavailable" };
    const newsStats = newsService.getStatistics ? newsService.getStatistics() : { error: "Stats unavailable" };
    res.status(200).json({ gemini: geminiStats, news: newsStats, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Error in GET /api/stats/keys:', error.message);
    next(error);
  }
});

// POST /api/fetch-news - Trigger background news fetch
let isFetchRunning = false; // Simple lock
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch trigger ignored: Fetch already running.');
    return res.status(429).json({ message: 'Fetch process already running. Please wait.' });
  }
  console.log('📰 Manual fetch triggered via API...');
  isFetchRunning = true;

  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting background.', timestamp: new Date().toISOString() });

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Manual fetch background process finished.');
     });
});

// --- Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews(); // Fetches US/IN/World news
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched, ending cycle.");
      return stats;
    }

    // Process articles sequentially to manage free tier rate limits
    for (const article of rawArticles) {
        try {
            // 1. Validate Structure
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++;
                continue;
            }

            // 2. Check Duplicates
            const exists = await Article.findOne({ url: article.url }, { _id: 1 }).lean();
            if (exists) {
                stats.skipped_duplicate++;
                continue;
            }

            // 3. Analyze with Gemini (includes retries & safety settings)
            console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
            const analysis = await geminiService.analyzeArticle(article);

            // 4. Prepare Data (with defaults and validation)
            const newArticleData = {
              headline: article.title,
              summary: analysis.summary || 'Summary unavailable',
              source: article.source?.name || 'Unknown Source',
              category: analysis.category || 'General',
              politicalLean: analysis.politicalLean || (analysis.analysisType === 'SentimentOnly' ? 'Not Applicable' : 'Center'),
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
              analysisType: analysis.analysisType || 'Full',
              sentiment: analysis.sentiment || 'Neutral',
              // Use analysis results, defaulting to 0, ensuring 0 for SentimentOnly
              biasScore: analysis.analysisType !== 'SentimentOnly' ? (Number(analysis.biasScore) || 0) : 0,
              biasLabel: analysis.biasLabel,
              biasComponents: analysis.biasComponents || {},
              credibilityScore: analysis.analysisType !== 'SentimentOnly' ? (Number(analysis.credibilityScore) || 0) : 0,
              credibilityGrade: analysis.credibilityGrade,
              credibilityComponents: analysis.credibilityComponents || {},
              reliabilityScore: analysis.analysisType !== 'SentimentOnly' ? (Number(analysis.reliabilityScore) || 0) : 0,
              reliabilityGrade: analysis.reliabilityGrade,
              reliabilityComponents: analysis.reliabilityComponents || {},
              trustScore: analysis.analysisType !== 'SentimentOnly' ? (Number(analysis.trustScore) || 0) : 0,
              trustLevel: analysis.trustLevel,
              coverageLeft: analysis.coverageLeft || 0, // Default coverage if missing
              coverageCenter: analysis.coverageCenter || 0,
              coverageRight: analysis.coverageRight || 0,
              clusterId: analysis.clusterId,
              keyFindings: analysis.keyFindings || [],
              recommendations: analysis.recommendations || [],
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };

            // Recalculate trust score if needed
            if (newArticleData.analysisType === 'Full' && newArticleData.trustScore === 0 && newArticleData.credibilityScore > 0 && newArticleData.reliabilityScore > 0) {
              newArticleData.trustScore = Math.round(Math.sqrt(newArticleData.credibilityScore * newArticleData.reliabilityScore));
            }

            // 5. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (${savedArticle.analysisType})`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            // IMPORTANT: If you have NOT enabled billing for Gemini API, uncomment the next line.
            // If you HAVE enabled billing, KEEP the next line commented out.
            await sleep(31000); // Wait 31 seconds (allows slightly under 2 RPM)
            // ----------------------------------------

        } catch (error) {
            // Log errors during individual article processing but continue the loop
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
        }
    } // End loop

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
    return stats;

  } catch (error) { // Catch critical errors during the initial news fetch stage
    console.error('❌ CRITICAL Error during news fetch stage:', error.message);
    stats.errors++;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
    // Allow process to end without throwing if run by cron
  }
}

// --- Sleep Function ---
function sleep(ms) {
  // console.log(`😴 Sleeping for ${ms / 1000} seconds...`); // Uncomment for debugging delay
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Scheduled Tasks ---

// Auto-fetch every 30 minutes
cron.schedule('*/30 * * * *', () => {
  if (isFetchRunning) {
    console.log('⏰ Cron: Skipping scheduled fetch - previous job still active.');
    return;
  }
  console.log('⏰ Cron: Triggering scheduled news fetch...');
  isFetchRunning = true;

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ CRITICAL Error during scheduled fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Scheduled fetch process complete.');
     });
});

// Auto-cleanup daily at 2 AM server time
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Cron: Triggering daily article cleanup...');
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Limit deletion batch size for safety and performance
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
    console.log(`🗑️ Cleanup successful: Deleted ${result.deletedCount} articles older than 7 days (batch limit 5000).`);
  } catch (error) {
    console.error('❌ CRITICAL Error during scheduled cleanup:', error.message);
  }
});

// --- Error Handling & Server Startup ---

// 404 Handler for undefined routes
app.use((req, res, next) => {
  res.status(404).json({ error: `Not Found - Cannot ${req.method} ${req.originalUrl}` });
});

// Global Error Handler (must be the LAST middleware)
app.use((err, req, res, next) => {
  console.error('💥 Global Error Handler:', err);
  const statusCode = err.status || err.statusCode || 500;
  // Send a generic message in production
  const message = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(statusCode).json({
    error: {
      message: message,
      // stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined, // Optionally include stack in dev
    }
  });
});

const PORT = process.env.PORT || 3001; // Render injects PORT

// Start Server
app.listen(PORT, () => {
  console.log(`\n🚀 Server listening on port ${PORT}`);
  console.log(`🔗 Health Check: http://localhost:${PORT}/`);
  console.log(`API available at /api`);
  console.log(`🕒 News fetch scheduled: Every 30 minutes`);
  console.log(`🗑️ Cleanup scheduled: Daily at 2 AM`);
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} received. Initiating graceful shutdown...`);
  // Add server.close() if needed for specific setups
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
