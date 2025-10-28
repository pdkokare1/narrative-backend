// server.js (FINAL v2.12 - Unlocked Stats)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- ADD THIS (1 of 3) ---
// Import Firebase Admin
const admin = require('firebase-admin');

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService'); // Assumes newsService.js has focused fetching

// --- ADDED: Import the new Profile model ---
const Profile = require('./models/profileModel');
// --- ADDED: Import the new ActivityLog model ---
const ActivityLog = require('./models/activityLogModel');

// --- ADD THIS (2 of 3) ---
// Initialize Firebase Admin
try {
  // This path works because Render's Secret File is at the root
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK Initialized');
} catch (error) {
  console.error('❌ Firebase Admin Init Error:', error.message);
}
// --- END ---

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

// --- ADD THIS (3 of 3) ---
// This is the "Token Verification" function (middleware)
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1]; // Get token

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    // Firebase Admin checks if the token is valid
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Add user info to the request
    next(); // Token is valid, proceed to the API route
  } catch (error) {
    console.warn('⚠️ Auth Error:', error.code, error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
  }
};

// Apply the token check to ALL routes that start with /api/
// This "locks" your entire API behind the login.
app.use('/api/', checkAuth);
// --- END ---

// --- ADDED: USER PROFILE ROUTES ---

// GET /api/profile/me - Checks if a profile exists for the logged-in user
app.get('/api/profile/me', async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.user.uid }).lean();

    if (!profile) {
      // This is not an "error", it just means they need to create one.
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Profile found, send it
    res.status(200).json(profile);
  } catch (error) {
    console.error('Error in GET /api/profile/me:', error.message);
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// POST /api/profile - Creates a new profile
app.post('/api/profile', async (req, res) => {
  try {
    const { username } = req.body;
    const { uid, email } = req.user; // Get from Firebase token

    if (!username || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    const cleanUsername = username.trim();

    // Check if username is already taken
    const existingUsername = await Profile.findOne({ username: cleanUsername }).lean();
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Check if they already have a profile
    const existingProfile = await Profile.findOne({ userId: uid }).lean();
    if (existingProfile) {
      return res.status(409).json({ error: 'Profile already exists' });
    }

    // Create and save the new profile
    const newProfile = new Profile({
      userId: uid,
      email: email,
      username: cleanUsername,
    });

    await newProfile.save();
    res.status(201).json(newProfile); // Send back the new profile

  } catch (error) {
    console.error('Error in POST /api/profile:', error.message);
    // Handle duplicate key errors (for email or userId)
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A profile for this user or email already exists.' });
    }
    res.status(500).json({ error: 'Error creating profile' });
  }
});

// --- ADDED: USER STATS ROUTE ---

// POST /api/activity/log-view - Logs that a user viewed an article
app.post('/api/activity/log-view', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    // --- NEW: Create a detailed log entry ---
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_analysis'
    });

    // --- We keep this for now so the simple profile page doesn't break ---
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid }, // Find this user
      { $inc: { articlesViewedCount: 1 } }, // Increment this field
      { new: true, upsert: true } // Return updated doc, create field if !exists
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

// --- UPDATED THIS ENDPOINT ---
// POST /api/activity/log-compare - Logs that a user clicked "compare"
app.post('/api/activity/log-compare', async (req, res) => {
  try {
    const { articleId } = req.body; // Expect the ID of the article they clicked "compare" on
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    // --- NEW: Create a detailed log entry ---
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_comparison'
    });

    // --- We keep this for now ---
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { comparisonsViewedCount: 1 } }, // Increment the new field
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

// --- UPDATED THIS ENDPOINT ---
// POST /api/activity/log-share - Logs that a user clicked "share"
app.post('/api/activity/log-share', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    // --- NEW: Create a detailed log entry ---
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'share_article'
    });

    // --- We keep this for now ---
    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { articlesSharedCount: 1 } }, // Increment the new field
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

// --- *** NEW ENDPOINT *** ---
// POST /api/activity/log-read - Logs that a user clicked "Read Article"
app.post('/api/activity/log-read', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    // Create a detailed log entry for 'read_external'
    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'read_external'
    });

    // Note: We don't increment a simple counter in the Profile model for this one
    // We will aggregate it in the /stats endpoint instead.

    res.status(200).json({
      message: 'Read activity logged'
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-read:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});


// --- *** HEAVILY MODIFIED ENDPOINT *** ---
// GET /api/profile/stats - Fetch ALL aggregated stats for a user
app.get('/api/profile/stats', async (req, res) => {
  try {
    const userId = req.user.uid;
    // const days = parseInt(req.query.days) || 90; // Default to 90 days
    // const endDate = new Date();
    // const startDate = new Date();
    // startDate.setDate(endDate.getDate() - days);
    
    // We are fetching ALL-TIME stats, so no date range is needed in $match
    // If we want to re-add timeframes, we just add the $match (timestamp:...)
    // back into the $facet pipelines.

    const stats = await ActivityLog.aggregate([
      // 1. Filter logs for the current user
      {
        $match: {
          userId: userId
        }
      },
      // 2. Lookup the article details for each log
      {
        $lookup: {
          from: 'articles', // The name of the articles collection
          localField: 'articleId',
          foreignField: '_id',
          as: 'articleDetails'
        }
      },
      // 3. Deconstruct the articleDetails array
      {
        $unwind: {
          path: '$articleDetails',
          preserveNullAndEmptyArrays: true // Keep logs even if article was deleted
        }
      },
      // 4. Group by multiple criteria (daily counts and lean counts)
      {
        $facet: {
          // --- Calculate daily counts (for 'view_analysis') ---
          dailyCounts: [
            { $match: { action: 'view_analysis' } },
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id': 1 } },
            { $project: { _id: 0, date: '$_id', count: 1 } }
          ],

          // --- Calculate political lean distribution (for 'view_analysis') ---
          leanDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.politicalLean': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.politicalLean',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          
          // --- *** NEW FACETS START HERE *** ---
          
          // --- Calculate political lean distribution (for 'share_article') ---
          leanDistribution_shared: [
             {
               $match: { 
                 'action': 'share_article',
                 'articleDetails.politicalLean': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.politicalLean',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],

          // --- Calculate Category distribution (for 'view_analysis') ---
          categoryDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.category': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.category',
                count: { $sum: 1 }
              }
            },
             { $sort: { count: -1 } }, // Sort by most read
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          
          // --- Calculate Quality distribution (for 'view_analysis') ---
          qualityDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.credibilityGrade': { $exists: true, $ne: null } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.credibilityGrade',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],

          // --- Calculate Total Counts for all actions ---
          totalCounts: [
            {
              $group: {
                _id: '$action', // Group by action type
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ]
          
          // --- *** NEW FACETS END HERE *** ---
        }
      }
    ]);

    // Format the results
    const results = {
      timeframeDays: 'All Time', // Hardcoded to 'All Time'
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

// --- END OF ADDED ROUTES ---


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
  clusterTopic: { type: String, index: true, trim: true }, // NEW FIELD FOR CLUSTERING
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.11' } // Version bump
}, {
  timestamps: true, // Adds createdAt and updatedAt
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 }); // For cleanup
articleSchema.index({ clusterTopic: 1, publishedAt: -1 }); // Index for new field
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 }); // NEW: For duplicate check
articleSchema.index({ analysisType: 1, publishedAt: -1 }); // NEW: For review filter

const Article = mongoose.model('Article', articleSchema);

// --- API Routes ---

// GET / - Health Check (This is NOT protected, which is good)
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Gamut API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      'PDF-Based Trust Score (OTS = sqrt(UCS*URS))',
      'AI-Powered Event Clustering',
      'Junk/Ad Article Filtering',
      'Advanced Duplicate Checking',
      'Review/Opinion Filter', // NEW
      'Consolidated Analysis UI'
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});

// GET /api/articles - Fetch articles (This route is now PROTECTED)
app.get('/api/articles', async (req, res, next) => {
  // You can optionally see which user is making the request
  // console.log('API called by user:', req.user.uid);
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

    // --- UPDATED Quality Filter Logic ---
    if (quality) {
      if (quality === 'Review / Opinion') {
          query.analysisType = 'SentimentOnly';
      } else {
        // Ensure only 'Full' analysis articles are considered for score filters
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
    }
    // --- End Quality Filter Logic ---

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

// GET /api/articles/:id - Fetch single article (This route is now PROTECTED)
app.get('/api/articles/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID format' });
    }
    const article = await Article.findById(id).lean();
    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.status(200).json(article);
  } catch (error)
 {
    console.error(`❌ Error in GET /api/articles/${req.params.id}:`, error.message);
    next(error);
  }
});

// GET /api/cluster/:clusterId - Fetch cluster data (This route is now PROTECTED)
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

// GET /api/stats - Fetch overall stats (This route is now PROTECTED)
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

// GET /api/stats/keys - Fetch API key usage stats (This route is now PROTECTED)
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

// POST /api/fetch-news - Trigger background news fetch (This route is now PROTECTED)
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
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, skipped_junk: 0, errors: 0, start_time: Date.now() };

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

            // 3. Analyze with Gemini (includes retries & safety settings)
            console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
            const analysis = await geminiService.analyzeArticle(article);

            // 3.5. Check for Junk Articles
            if (analysis.isJunk) {
                stats.skipped_junk++;
                console.log(`🚮 Skipping junk/ad: ${article.title.substring(0, 50)}...`);
                continue;
            }

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
              biasScore: analysis.biasScore, // Directly from parser
              biasLabel: analysis.biasLabel,
              biasComponents: analysis.biasComponents || {},
              credibilityScore: analysis.credibilityScore, // Directly from parser
              credibilityGrade: analysis.credibilityGrade,
              credibilityComponents: analysis.credibilityComponents || {},
              reliabilityScore: analysis.reliabilityScore, // Directly from parser
              reliabilityGrade: analysis.reliabilityGrade,
              reliabilityComponents: analysis.reliabilityComponents || {},
              trustScore: analysis.trustScore, // Directly from parser (now calculated)
              trustLevel: analysis.trustLevel,
              coverageLeft: analysis.coverageLeft || 0, // Default coverage if missing
              coverageCenter: analysis.coverageCenter || 0,
              coverageRight: analysis.coverageRight || 0,
              clusterId: null, // Will be set below
              clusterTopic: analysis.clusterTopic, // NEW
              keyFindings: analysis.keyFindings || [],
              recommendations: analysis.recommendations || [],
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };

            // 4.5. Handle Clustering
            if (newArticleData.clusterTopic && newArticleData.analysisType === 'Full') {
                const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
                // Find a recent article with the same topic to get its clusterId
                const existingCluster = await Article.findOne({
                    clusterTopic: newArticleData.clusterTopic,
                    publishedAt: { $gte: threeDaysAgo } // Look in last 3 days
                }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

                if (existingCluster && existingCluster.clusterId) {
                    newArticleData.clusterId = existingCluster.clusterId;
                    // console.log(`Assigning existing clusterId [${newArticleData.clusterId}] for topic: "${newArticleData.clusterTopic}"`);
                } else {
                    // This is a new topic, find the max clusterId and add 1
                    const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
                    newArticleData.clusterId = (maxIdDoc?.clusterId || 0) + 1;
                    // console.log(`Assigning NEW clusterId [${newArticleData.clusterId}] for topic: "${newArticleData.clusterTopic}"`);
                }
            }
            // (End Clustering Logic)

            // 5. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (${savedArticle.analysisType})`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
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
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_junk} junk, ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
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
// --- THIS LINE IS FIXED ---
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
const HOST = process.env.HOST || '0.0.0.0'; // Bind to all interfaces

// Start Server
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
