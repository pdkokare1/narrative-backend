// server.js (v3.0.0 - Smart Clustering & Feed)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import Firebase Admin
const admin = require('firebase-admin');

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService');

// --- Models ---
const Profile = require('./models/profileModel');
const ActivityLog = require('./models/activityLogModel');

// Initialize Firebase Admin
try {
  const serviceAccount = require('./serviceAccountKey.json');
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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Token Verification Middleware ---
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
app.use('/api/', checkAuth); // Apply auth to all /api/ routes

// --- Profile & Activity Routes [UNCHANGED] ---

// GET /api/profile/me
app.get('/api/profile/me', async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.user.uid }).lean();
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.status(200).json(profile);
  } catch (error) {
    console.error('Error in GET /api/profile/me:', error.message);
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// POST /api/profile
app.post('/api/profile', async (req, res) => {
  try {
    const { username } = req.body;
    const { uid, email } = req.user;
    if (!username || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    const cleanUsername = username.trim();
    const existingUsername = await Profile.findOne({ username: cleanUsername }).lean();
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const existingProfile = await Profile.findOne({ userId: uid }).lean();
    if (existingProfile) {
      return res.status(409).json({ error: 'Profile already exists' });
    }
    const newProfile = new Profile({
      userId: uid,
      email: email,
      username: cleanUsername,
    });
    await newProfile.save();
    res.status(201).json(newProfile);
  } catch (error) {
    console.error('Error in POST /api/profile:', error.message);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A profile for this user or email already exists.' });
    }
    res.status(500).json({ error: 'Error creating profile' });
  }
});

// POST /api/activity/log-view
app.post('/api/activity/log-view', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_analysis'
    });
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { articlesViewedCount: 1 } },
      { new: true, upsert: true }
    );
    res.status(200).json({
      message: 'Activity logged',
      articlesViewedCount: updatedProfile.articlesViewedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-view:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// POST /api/activity/log-compare
app.post('/api/activity/log-compare', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_comparison'
    });
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { comparisonsViewedCount: 1 } },
      { new: true, upsert: true }
    );
    res.status(200).json({
      message: 'Compare activity logged',
      comparisonsViewedCount: updatedProfile.comparisonsViewedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-compare:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// POST /api/activity/log-share
app.post('/api/activity/log-share', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'share_article'
    });
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { articlesSharedCount: 1 } },
      { new: true, upsert: true }
    );
    res.status(200).json({
      message: 'Share activity logged',
      articlesSharedCount: updatedProfile.articlesSharedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-share:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// POST /api/activity/log-read
app.post('/api/activity/log-read', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'read_external'
    });
    res.status(200).json({ message: 'Read activity logged' });
  } catch (error) {
    console.error('Error in POST /api/activity/log-read:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// GET /api/profile/stats
app.get('/api/profile/stats', async (req, res) => {
  try {
    const userId = req.user.uid;
    const stats = await ActivityLog.aggregate([
      { $match: { userId: userId } },
      {
        $lookup: {
          from: 'articles',
          localField: 'articleId',
          foreignField: '_id',
          as: 'articleDetails'
        }
      },
      { $unwind: { path: '$articleDetails', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          dailyCounts: [
            { $match: { action: 'view_analysis' } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' } }, count: { $sum: 1 } } },
            { $sort: { '_id': 1 } },
            { $project: { _id: 0, date: '$_id', count: 1 } }
          ],
          leanDistribution_read: [
             { $match: { 'action': 'view_analysis', 'articleDetails.politicalLean': { $exists: true } } },
             { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
             { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          leanDistribution_shared: [
             { $match: { 'action': 'share_article', 'articleDetails.politicalLean': { $exists: true } } },
             { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
             { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          categoryDistribution_read: [
             { $match: { 'action': 'view_analysis', 'articleDetails.category': { $exists: true } } },
             { $group: { _id: '$articleDetails.category', count: { $sum: 1 } } },
             { $sort: { count: -1 } },
             { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          qualityDistribution_read: [
             { $match: { 'action': 'view_analysis', 'articleDetails.credibilityGrade': { $exists: true, $ne: null } } },
             { $group: { _id: '$articleDetails.credibilityGrade', count: { $sum: 1 } } },
             { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],
          totalCounts: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ]
        }
      }
    ]);
    const results = {
      timeframeDays: 'All Time',
      dailyCounts: stats[0]?.dailyCounts || [],
      leanDistribution_read: stats[0]?.leanDistribution_read || [],
      leanDistribution_shared: stats[0]?.leanDistribution_shared || [],
      categoryDistribution_read: stats[0]?.categoryDistribution_read || [],
      qualityDistribution_read: stats[0]?.qualityDistribution_read || [],
      totalCounts: stats[0]?.totalCounts || [],
    };
    res.status(200).json(results);
  } catch (error) {
    console.error('Error in GET /api/profile/stats:', error.message);
    res.status(500).json({ error: 'Error fetching profile statistics' });
  }
});
// --- End Profile & Activity Routes ---


// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
mongoose.connection.on('error', err => { console.error('❌ MongoDB runtime error:', err.message); });
mongoose.connection.on('disconnected', () => { console.warn('⚠️ MongoDB disconnected.'); });

// --- Mongoose Schema ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true, index: true }, // Added index
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
  publishedAt: { type: Date, default: Date.now, index: true },
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'], index: true }, // Added index
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
  trustScore: { type: Number, default: 0, min: 0, max: 100, index: true }, // Added index
  trustLevel: String,
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  clusterTopic: { type: String, index: true, trim: true },
  country: { type: String, index: true, trim: true }, // From last step
  region: { type: String, index: true, trim: true }, // From last step
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '3.0.0' } // --- *** VERSION BUMP *** ---
}, {
  timestamps: true,
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes (cleaned up)
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ createdAt: 1 }); // For cleanup
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });
// --- *** NEW 3-PART CLUSTER INDEX *** ---
articleSchema.index({ clusterTopic: 1, country: 1, category: 1, publishedAt: -1 });

const Article = mongoose.model('Article', articleSchema);

// --- API Routes ---

// GET / - Health Check
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Gamut API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      '3-Part Smart Clustering (Topic, Country, Category)',
      '7-Day Cluster Window',
      'Smart Feed De-duplication (clusterCount)',
      'Region Filtering (India/Global)',
      'Article Type Filtering (News/Opinion)',
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});

// --- *** NEW: GET /api/articles - SMART FEED *** ---
app.get('/api/articles', async (req, res, next) => {
  try {
    // 1. Parse Filters
    const {
      category = 'All Categories',
      lean = 'All Leans',
      quality = 'All Quality Levels',
      sort = 'Latest First',
      region = 'Global', // NEW: Default to Global
      type = 'All Types', // NEW
    } = req.query;

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // 2. Build Match Query
    let matchQuery = {};
    if (category !== 'All Categories') matchQuery.category = category;
    if (lean !== 'All Leans') matchQuery.politicalLean = lean;
    
    // NEW: Region Filter
    if (region !== 'All') matchQuery.region = region;
    
    // NEW: Article Type Filter
    if (type === 'Hard News') matchQuery.analysisType = 'Full';
    if (type === 'Opinion & Reviews') matchQuery.analysisType = 'SentimentOnly';
    // 'All Types' means no filter is added

    // NEW: Quality Filter (now only applies if type is NOT Opinion)
    if (type !== 'Opinion & Reviews' && quality !== 'All Quality Levels') {
      matchQuery.analysisType = 'Full'; // Ensure we are only looking at scored articles
      matchQuery.trustScore = matchQuery.trustScore || {};
      const rangeMatch = quality.match(/(\d+)-(\d+)/);
      if (rangeMatch) {
        matchQuery.trustScore.$gte = parseInt(rangeMatch[1]);
        matchQuery.trustScore.$lt = parseInt(rangeMatch[2]) + 1;
      } else if (quality.includes('0-59')) {
        matchQuery.trustScore = { $lt: 60 };
      }
    }
    
    // 3. Build Sort Logic
    let sortQuery = { "newestArticle.publishedAt": -1, "newestArticle.createdAt": -1 }; // Default
    switch (sort) {
      case 'Highest Quality':
        sortQuery = { "newestArticle.trustScore": -1, ...sortQuery };
        break;
      case 'Most Covered':
        sortQuery = { clusterCount: -1, ...sortQuery }; // Sort by new count
        break;
      case 'Lowest Bias':
        sortQuery = { "newestArticle.biasScore": 1, ...sortQuery };
        break;
      // 'Latest First' is the default
    }

    // 4. Run Aggregation
    const aggregationResults = await Article.aggregate([
      // Stage 1: Match all articles that fit the filters
      { $match: matchQuery },
      
      // Stage 2: Sort by published date to find the newest in each cluster
      { $sort: { publishedAt: -1, createdAt: -1 } },
      
      // Stage 3: Group by clusterId to de-duplicate
      {
        $group: {
          _id: "$clusterId",
          newestArticle: { $first: "$$ROOT" }, // Get the entire newest article
          clusterCount: { $sum: 1 } // Count articles in this cluster
        }
      },
      
      // Stage 4: Promote the newest article to the root
      { $replaceRoot: { newRoot: "$newestArticle" } },
      
      // Stage 5: Add the clusterCount field back to the article
      // (This is a bit complex, $group strips it, so we re-lookup)
      // A more efficient way is to merge the count in
      {
         $addFields: {
           // We lost clusterCount in $replaceRoot, let's look it up again.
           // This is simplified. A better way is to merge objects in $group.
           // Let's fix this.
         }
      }
    ]);
    
    // --- *** REVISED AGGREGATION (More Efficient) *** ---
    const aggregation = await Article.aggregate([
      // Stage 1: Match all articles that fit the filters
      { $match: matchQuery },
      
      // Stage 2: Sort by published date to find the newest in each cluster
      { $sort: { publishedAt: -1, createdAt: -1 } },
      
      // Stage 3: Group by clusterId to de-duplicate
      {
        $group: {
          _id: "$clusterId",
          newestArticle: { $first: "$$ROOT" }, // Get the entire newest article
          clusterCount: { $sum: 1 } // Count articles in this cluster
        }
      },
      
      // Stage 4: Merge the clusterCount into the newestArticle object
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [
              "$newestArticle",
              { clusterCount: "$clusterCount" } // Add the count
            ]
          }
        }
      },

      // Stage 5: Re-sort the *unique* articles based on user's preference
      { $sort: sortQuery },

      // Stage 6: Facet for pagination (runs two queries in parallel)
      {
        $facet: {
          // Branch 1: Get the total count of unique articles
          pagination: [
            { $count: "total" }
          ],
          // Branch 2: Get the paginated data
          articles: [
            { $skip: offset },
            { $limit: limit }
          ]
        }
      }
    ]).allowDiskUse(true); // Allow using disk for large sorts

    const articles = aggregation[0].articles;
    const total = aggregation[0].pagination[0]?.total || 0;

    res.status(200).json({
      articles,
      pagination: { total, limit, offset, hasMore: (offset + articles.length) < total }
    });

  } catch (error) {
    console.error('❌ Error in GET /api/articles:', error.message);
    next(error);
  }
});
// --- *** END NEW GET /api/articles *** ---


// GET /api/articles/:id
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

// GET /api/cluster/:clusterId
app.get('/api/cluster/:clusterId', async (req, res, next) => {
  try {
    const clusterIdNum = parseInt(req.params.clusterId);
    if (isNaN(clusterIdNum)) return res.status(400).json({ error: 'Invalid cluster ID' });

    // --- *** MODIFIED: Now finds ALL analysis types for comparison *** ---
    const articles = await Article.find({ clusterId: clusterIdNum })
      .sort({ trustScore: -1, publishedAt: -1 })
      .lean();

    const grouped = articles.reduce((acc, article) => {
      const lean = article.politicalLean;
      if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
      else if (lean === 'Center') acc.center.push(article);
      else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
      else acc.center.push(article); // Put 'Not Applicable' in center
      return acc;
    }, { left: [], center: [], right: [] });

    const totalArticles = articles.length;
    // --- *** MODIFIED: Only average 'Full' analysis articles *** ---
    const scoredArticles = articles.filter(a => a.analysisType === 'Full');
    const scoredCount = scoredArticles.length;
    
    const calculateAverage = (field) => scoredCount > 0
      ? Math.round(scoredArticles.reduce((sum, a) => sum + (a[field] || 0), 0) / scoredCount)
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

// GET /api/stats
app.get('/api/stats', async (req, res, next) => {
  try {
    const [statsData, leanDistribution, categoryDistribution] = await Promise.all([
        Article.aggregate([
            { $facet: {
                totalArticles: [{ $count: "count" }],
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

// GET /api/stats/keys
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

// POST /api/fetch-news
let isFetchRunning = false;
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

// --- *** NEW: Helper list for Region Tagging *** ---
const INDIAN_SOURCE_KEYWORDS = [
    'india', 'hindu', 'deccan', 'tribuneindia', 'swarajya', 'opindia', 'wire.in', 'scroll.in',
    'ndtv', 'timesnow', 'indiatoday', 'republicworld', 'zeenews', 'wionews', 'firstpost',
    'oneindia', 'livemint', 'financialexpress', 'businesstoday', 'anandabazar',
    'eisamay', 'sangbadpratidin'
];
const INDIAN_TITLE_KEYWORDS = [
    'india', 'indian', 'delhi', 'mumbai', 'kolkata', 'chennai', 'bengaluru',
    'hyderabad', 'pune', 'modi', 'gandhi', 'bjp', 'congress'
];
// --- *** END HELPER LIST *** ---

// --- Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, skipped_junk: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews();
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched, ending cycle.");
      return stats;
    }

    for (const article of rawArticles) {
        try {
            // 1. Validate Structure
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++;
                continue;
            }

            // 2. Check Duplicates (ADVANCED)
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

            // 3. Analyze with Gemini
            console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
            const analysis = await geminiService.analyzeArticle(article);

            // 3.5. Check for Junk Articles
            if (analysis.isJunk) {
                stats.skipped_junk++;
                console.log(`🚮 Skipping junk/ad: ${article.title.substring(0, 50)}...`);
                continue;
            }

            // --- *** NEW: 2-Step Region Tagging Logic *** ---
            let region = 'Global'; // Default
            const sourceName = (article.source?.name || '').toLowerCase();
            const headline = (article.title || '').toLowerCase();
            const topic = (analysis.clusterTopic || '').toLowerCase();

            // Step 1: Check source name
            if (INDIAN_SOURCE_KEYWORDS.some(keyword => sourceName.includes(keyword))) {
                region = 'India';
            } 
            // Step 2: If still global, check title/topic keywords
            else if (INDIAN_TITLE_KEYWORDS.some(keyword => headline.includes(keyword) || topic.includes(keyword))) {
                region = 'India';
            }
            // --- *** END Region Tagging Logic *** ---

            // 4. Prepare Data
            const newArticleData = {
              headline: article.title,
              summary: analysis.summary,
              source: article.source?.name || 'Unknown Source',
              category: analysis.category,
              politicalLean: analysis.politicalLean,
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
              analysisType: analysis.analysisType,
              sentiment: analysis.sentiment,
              biasScore: analysis.biasScore,
              biasLabel: analysis.biasLabel,
              biasComponents: analysis.biasComponents,
              credibilityScore: analysis.credibilityScore,
              credibilityGrade: analysis.credibilityGrade,
              credibilityComponents: analysis.credibilityComponents,
              reliabilityScore: analysis.reliabilityScore,
              reliabilityGrade: analysis.reliabilityGrade,
              reliabilityComponents: analysis.reliabilityComponents,
              trustScore: analysis.trustScore,
              trustLevel: analysis.trustLevel,
              coverageLeft: analysis.coverageLeft || 0,
              coverageCenter: analysis.coverageCenter || 0,
              coverageRight: analysis.coverageRight || 0,
              clusterId: null, // Will be set below
              clusterTopic: analysis.clusterTopic,
              country: analysis.country, // NEW from AI
              region: region, // NEW from 2-step logic
              keyFindings: analysis.keyFindings,
              recommendations: analysis.recommendations,
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };

            // --- *** NEW: Smart Clustering Logic *** ---
            if (newArticleData.clusterTopic && newArticleData.country && newArticleData.category) {
                // --- Window expanded to 7 days ---
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                
                // --- Find cluster using 3-part key ---
                const existingCluster = await Article.findOne({
                    clusterTopic: newArticleData.clusterTopic,
                    country: newArticleData.country,
                    category: newArticleData.category,
                    publishedAt: { $gte: sevenDaysAgo }
                    // --- REMOVED analysisType check ---
                }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

                if (existingCluster && existingCluster.clusterId) {
                    newArticleData.clusterId = existingCluster.clusterId;
                } else {
                    // This is a new topic, find the max clusterId and add 1
                    const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
                    newArticleData.clusterId = (maxIdDoc?.clusterId || 0) + 1;
                }
            }
            // --- *** END Smart Clustering Logic *** ---

            // 5. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (${savedArticle.analysisType}) [Region: ${savedArticle.region}] [Cluster: ${savedArticle.clusterId}]`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            await sleep(31000); // Wait 31 seconds
            // ----------------------------------------

        } catch (error) {
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
        }
    } // End loop

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_junk} junk, ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
    return stats;

  } catch (error) {
    console.error('❌ CRITICAL Error during news fetch stage:', error.message);
    stats.errors++;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
  }
}

// --- Sleep Function ---
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Scheduled Tasks ---
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

// --- Error Handling & Server Startup ---
app.use((req, res, next) => {
  res.status(404).json({ error: `Not Found - Cannot ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('💥 Global Error Handler:', err);
  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(statusCode).json({
    error: { message: message }
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Server listening on host ${HOST}, port ${PORT}`);
  console.log(`🔗 Health Check: http://localhost:${PORT}/`);
  console.log(`API available at /api`);
  console.log(`🕒 News fetch scheduled: Every 30 minutes`);
  console.log(`🗑️ Cleanup scheduled: Daily at 2 AM`);
});

// --- Graceful Shutdown ---
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
