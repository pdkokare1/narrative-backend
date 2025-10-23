// server.js (FINAL VERSION 2.3 - Background processing, 30min schedule)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Services are imported at the top ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService');

const app = express();

app.set('trust proxy', 1); // Necessary for rate limiting behind proxies like Render

app.use(helmet()); // Sets various security headers
app.use(compression()); // Compresses responses
app.use(cors()); // Allows requests from your Vercel frontend
app.use(express.json()); // Parses incoming JSON requests

// Rate Limiter: Limit requests per IP to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use('/api/', limiter); // Apply limiter only to API routes

// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err)); // More specific error log

// --- Mongoose Schema Definition ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true }, // Added trim
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true },
  imageUrl: { type: String, trim: true }, // Added trim
  publishedAt: { type: Date, default: Date.now }, // Default if missing
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'] },
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  biasScore: { type: Number, default: 0, min: 0, max: 100 }, // Added validation
  biasLabel: String,
  biasComponents: {
    linguistic: { sentimentPolarity: Number, emotionalLanguage: Number, loadedTerms: Number, complexityBias: Number },
    sourceSelection: { sourceDiversity: Number, expertBalance: Number, attributionTransparency: Number },
    demographic: { genderBalance: Number, racialBalance: Number, ageRepresentation: Number },
    framing: { headlineFraming: Number, storySelection: Number, omissionBias: Number }
  },
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 },
  credibilityGrade: String,
  credibilityComponents: { sourceCredibility: Number, factVerification: Number, professionalism: Number, evidenceQuality: Number, transparency: Number, audienceTrust: Number },
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
  reliabilityGrade: String,
  reliabilityComponents: { consistency: Number, temporalStability: Number, qualityControl: Number, publicationStandards: Number, correctionsPolicy: Number, updateMaintenance: Number },
  trustScore: { type: Number, default: 0, min: 0, max: 100 },
  trustLevel: String,
  coverageLeft: { type: Number, default: 0 }, // Add defaults
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: Number,
  keyFindings: [String],
  recommendations: [String],
  createdAt: { type: Date, default: Date.now, index: true }, // Added index
  updatedAt: { type: Date, default: Date.now },
  analysisVersion: { type: String, default: '2.3' } // Updated version
}, { timestamps: true }); // Automatically manage createdAt and updatedAt

// --- Indexes for efficient querying ---
articleSchema.index({ category: 1, createdAt: -1 });
articleSchema.index({ politicalLean: 1, createdAt: -1 }); // Compound index
articleSchema.index({ clusterId: 1, trustScore: -1 }); // Compound index
articleSchema.index({ trustScore: -1 });
articleSchema.index({ biasScore: 1 });
articleSchema.index({ publishedAt: -1 }); // Index published date

const Article = mongoose.model('Article', articleSchema);

// --- API Routes ---

// Health Check Route
app.get('/', (req, res) => {
  res.status(200).json({ // Use 200 OK status
    message: `The Narrative API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      'Enhanced Bias Detection',
      'Credibility & Reliability Scoring',
      'Trust Score Calculation',
      'Sentiment Analysis',
      'Analysis Type (Full/SentimentOnly)',
      'Story Clustering',
      'Advanced Filtering',
      'Auto-refresh every 30 minutes',
      'Background Fetch Processing'
    ],
    timestamp: new Date().toISOString(), // Use ISO format
    uptime: process.uptime ? Math.floor(process.uptime()) : 0
  });
});

// GET /api/articles - Fetch articles with filtering and pagination
app.get('/api/articles', async (req, res) => {
  try {
    // Input validation and sanitization (basic example)
    const category = req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null;
    const lean = req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null;
    const quality = req.query.quality && req.query.quality !== 'All Quality Levels' ? String(req.query.quality) : null;
    const minTrust = req.query.minTrust ? parseInt(req.query.minTrust) : null;
    const maxBias = req.query.maxBias ? parseInt(req.query.maxBias) : null;
    const sort = String(req.query.sort || 'Latest First');
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Build query object dynamically
    let query = {};
    if (category) query.category = category;
    if (lean) query.politicalLean = lean;

    // Quality filter logic
    if (quality) {
        query.trustScore = query.trustScore || {}; // Ensure trustScore object exists
        if (quality.includes('90-100')) query.trustScore.$gte = 90;
        else if (quality.includes('80-89')) { query.trustScore.$gte = 80; query.trustScore.$lt = 90; }
        else if (quality.includes('70-79')) { query.trustScore.$gte = 70; query.trustScore.$lt = 80; }
        else if (quality.includes('60-69')) { query.trustScore.$gte = 60; query.trustScore.$lt = 70; }
        else if (quality.includes('0-59')) query.trustScore.$lt = 60;
    }
    if (minTrust !== null && !isNaN(minTrust)) {
         query.trustScore = { ...query.trustScore, $gte: minTrust };
    }
     if (maxBias !== null && !isNaN(maxBias)) {
         query.biasScore = { $lte: maxBias };
    }

    // Determine sort option
    let sortOption = { publishedAt: -1, createdAt: -1 }; // Default sort by published, then created
    if (sort === 'Highest Quality') sortOption = { trustScore: -1, publishedAt: -1 };
    else if (sort === 'Most Covered') sortOption = { clusterId: 1, trustScore: -1, publishedAt: -1 }; // Sort by cluster, then quality
    else if (sort === 'Lowest Bias') sortOption = { biasScore: 1, publishedAt: -1 };

    // Fetch articles and count total matching documents
    const [articles, total] = await Promise.all([
      Article.find(query)
        .sort(sortOption)
        .limit(limit)
        .skip(offset)
        .lean(), // Use lean for faster read-only queries
      Article.countDocuments(query)
    ]);

    res.status(200).json({
      articles,
      pagination: {
        total,
        limit,
        offset,
        hasMore: (offset + articles.length) < total // More accurate hasMore calculation
      }
    });

  } catch (error) {
    console.error('❌ Error in GET /api/articles:', error);
    res.status(500).json({
      error: 'Failed to fetch articles',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// GET /api/articles/:id - Fetch a single article by its ID
app.get('/api/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID format' });
    }

    const article = await Article.findById(id).lean(); // Use lean

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.status(200).json(article);
  } catch (error) {
    console.error(`❌ Error in GET /api/articles/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch article details' });
  }
});

// GET /api/cluster/:clusterId - Fetch articles belonging to a cluster
app.get('/api/cluster/:clusterId', async (req, res) => {
  try {
    const clusterIdNum = parseInt(req.params.clusterId);
    if (isNaN(clusterIdNum)) {
      return res.status(400).json({ error: 'Invalid cluster ID' });
    }

    const articles = await Article.find({
      clusterId: clusterIdNum,
      analysisType: 'Full' // Only cluster full news articles
    }).sort({ trustScore: -1 }).lean(); // Sort within cluster, use lean

    // Group articles by political lean
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

    // Calculate cluster statistics
    const stats = {
      totalArticles,
      leftCount: grouped.left.length,
      centerCount: grouped.center.length,
      rightCount: grouped.right.length,
      averageBias: calculateAverage('biasScore'),
      averageTrust: calculateAverage('trustScore')
    };

    res.status(200).json({ ...grouped, stats });

  } catch (error) {
    console.error(`❌ Error in GET /api/cluster/${req.params.clusterId}:`, error);
    res.status(500).json({ error: 'Failed to fetch cluster data' });
  }
});

// GET /api/stats - Fetch overall application statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Run aggregations concurrently for better performance
    const [totalArticles, sources, categories, avgBiasResult, avgTrustResult, leanDistribution, categoryDistribution] = await Promise.all([
      Article.countDocuments(),
      Article.distinct('source'),
      Article.distinct('category'),
      Article.aggregate([
        { $match: { analysisType: 'Full', biasScore: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: '$biasScore' } } }
      ]).allowDiskUse(true), // Allow disk use for large aggregations
      Article.aggregate([
        { $match: { analysisType: 'Full', trustScore: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: '$trustScore' } } }
      ]).allowDiskUse(true),
      Article.aggregate([
        { $match: { analysisType: 'Full' } },
        { $group: { _id: '$politicalLean', count: { $sum: 1 } } }
      ]).allowDiskUse(true),
      Article.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]).allowDiskUse(true)
    ]);

    res.status(200).json({
      totalArticles,
      totalSources: sources.length,
      totalCategories: categories.length,
      averageBias: Math.round(avgBiasResult[0]?.avg || 0),
      averageTrust: Math.round(avgTrustResult[0]?.avg || 0),
      leanDistribution: leanDistribution.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}), // Format as object
      categoryDistribution: categoryDistribution.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}), // Format as object
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in GET /api/stats:', error);
    res.status(500).json({ error: 'Failed to fetch application statistics' });
  }
});

// GET /api/stats/keys - Fetch statistics about API key usage
app.get('/api/stats/keys', (req, res) => {
  try {
    res.status(200).json({
      gemini: geminiService.getStatistics(),
      news: newsService.getStatistics(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error in GET /api/stats/keys:', error);
    res.status(500).json({ error: 'Failed to get API key statistics' });
  }
});

// POST /api/fetch-news - Manually trigger the news fetching and analysis process (runs in background)
app.post('/api/fetch-news', (req, res) => {
  console.log('📰 Manual news fetch triggered via API...');
  // Respond immediately with 202 Accepted
  res.status(202).json({
    message: 'News fetch acknowledged. Analysis starting in the background.',
    timestamp: new Date().toISOString()
  });

  // Start the potentially long-running task without awaiting its completion
  fetchAndAnalyzeNews().catch(err => {
    // Log fatal errors during the background execution
    console.error('❌ FATAL Error during background fetchAndAnalyzeNews triggered manually:', err);
    // Consider adding more robust error reporting (e.g., to an external monitoring service)
  });
});

// --- Core News Fetching and Analysis Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews process...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews(); // This now fetches focused news
    stats.fetched = rawArticles.length;
    console.log(`📰 Found ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
        console.log("No articles fetched, ending process.");
        return stats; // Exit early if no articles
    }

    // Process articles concurrently using Promise.allSettled for robustness
    const analysisPromises = rawArticles.map(async (article) => {
        // 1. Basic Validation
        if (!article?.url || !article?.title || !article?.description || article.description.length < 30) { // Slightly shorter min length
            return { status: 'skipped_invalid', url: article?.url || 'unknown' };
        }

        // 2. Check for Duplicates
        // Consider adding a TTL index on 'url' in MongoDB for automatic cleanup?
        const exists = await Article.findOne({ url: article.url }, { _id: 1 }).lean(); // Check only for existence
        if (exists) {
            return { status: 'skipped_duplicate', url: article.url };
        }

        // 3. Analyze with Gemini (includes retries)
        console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
        const analysis = await geminiService.analyzeArticle(article);

        // 4. Prepare data for MongoDB, ensuring defaults and correct types
        const newArticleData = {
          headline: article.title,
          summary: analysis.summary || 'Summary not available',
          source: article.source?.name || 'Unknown Source',
          category: analysis.category || 'General',
          politicalLean: analysis.politicalLean || (analysis.analysisType === 'SentimentOnly' ? 'Not Applicable' : 'Center'),
          url: article.url,
          imageUrl: article.urlToImage,
          publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
          analysisType: analysis.analysisType || 'Full',
          sentiment: analysis.sentiment || 'Neutral',
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
          coverageLeft: analysis.coverageLeft,
          coverageCenter: analysis.coverageCenter,
          coverageRight: analysis.coverageRight,
          clusterId: analysis.clusterId,
          keyFindings: analysis.keyFindings || [],
          recommendations: analysis.recommendations || [],
          analysisVersion: Article.schema.path('analysisVersion').defaultValue // Use schema default
        };

        // Calculate trust score if needed (only for 'Full' analysis types)
         if (newArticleData.analysisType === 'Full' && newArticleData.trustScore === 0 && newArticleData.credibilityScore > 0 && newArticleData.reliabilityScore > 0) {
           newArticleData.trustScore = Math.round(Math.sqrt(newArticleData.credibilityScore * newArticleData.reliabilityScore));
         }

        // 5. Save to Database
        const savedArticle = await Article.create(newArticleData);
        console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (${savedArticle.analysisType})`);
        return { status: 'processed', url: article.url, id: savedArticle._id };
    });

    const results = await Promise.allSettled(analysisPromises);

    // 6. Tally results
    results.forEach(result => {
        if (result.status === 'fulfilled') {
            if (result.value.status === 'processed') stats.processed++;
            else if (result.value.status === 'skipped_duplicate') stats.skipped_duplicate++;
            else if (result.value.status === 'skipped_invalid') stats.skipped_invalid++;
        } else {
            // Log rejected promises (errors during validation, analysis, or saving)
            console.error(`❌ Error processing article: ${result.reason?.message || result.reason}`);
            stats.errors++;
        }
    });

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n✅ Fetch cycle completed in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate, ${stats.skipped_invalid} invalid, ${stats.errors} errors.\n`);
    return stats;

  } catch (error) { // Catch errors from initial newsService.fetchNews() call
    console.error('❌ CRITICAL Error during the news fetching stage:', error);
    stats.errors++; // Count this as an error
    stats.end_time = Date.now();
     const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
     console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
    throw error; // Re-throw to be caught by the caller (POST endpoint or cron job)
  }
}

// --- Scheduled Tasks ---

// Auto-fetch every 30 minutes
cron.schedule('*/30 * * * *', () => {
  console.log('⏰ Cron: Triggering scheduled news fetch...');
  // Run in background, log if it fails catastrophically
  fetchAndAnalyzeNews().catch(err => {
    console.error('❌ CRITICAL Error during scheduled fetchAndAnalyzeNews:', err);
  });
});

// Auto-cleanup old articles daily at 2 AM server time
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Cron: Triggering daily cleanup of old articles...');
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Add a safety limit to prevent accidental mass deletion
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
    console.log(`🗑️ Cleanup successful: Deleted ${result.deletedCount} articles older than 7 days (limit 5000).`);
  } catch (error) {
    console.error('❌ CRITICAL Error during scheduled cleanup:', error);
  }
});

// --- Error Handling & Server Startup ---

// 404 Handler for undefined routes (should be last route handler)
app.use((req, res, next) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// Global Error Handler (should be the very last app.use call)
app.use((err, req, res, next) => {
  console.error('💥 Global Error Handler caught an error:', err);
  // Basic error structure
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // Send JSON response
  res.status(statusCode).json({
    error: {
      message: message,
      // Include stack trace only in development
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    }
  });
});

const PORT = process.env.PORT || 3001; // Render provides the PORT environment variable

app.listen(PORT, () => {
  console.log(`\nServer listening on port ${PORT}`);
  console.log(`Access the health check at: http://localhost:${PORT}/`);
  console.log('--- Server Configuration ---');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database Connected: Yes`);
  console.log(`News Fetch Schedule: Every 30 minutes`);
  console.log(`Article Cleanup: Daily at 2 AM`);
  console.log('----------------------------\n');
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} signal received. Starting graceful shutdown...`);
  try {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('💾 MongoDB connection closed successfully.');
    // Add any other cleanup tasks here (e.g., close server explicitly if needed)
    console.log('✅ Server shut down gracefully.');
    process.exit(0); // Exit successfully
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    process.exit(1); // Exit with error code
  }
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Sent by Render/Docker
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Sent by Ctrl+C
