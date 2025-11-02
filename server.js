// In file: server.js
// --- FIX: Moved app.listen() inside the mongoose.connect().then() block ---
// This ensures the server only starts *after* the database is connected.
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
// --- Import the clustering service ---
const clusteringService = require('./services/clusteringService');

// --- Models ---
const Profile = require('./models/profileModel');
const ActivityLog = require('./models/activityLogModel');

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
// --- END ---

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


// --- Mongoose Schema ---
// We define the schema *before* the routes that use it.
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
  clusterTopic: { type: String, index: true, trim: true },
  clusterTopicVector: { type: [Number] }, // Field to store the vector
  country: { type: String, index: true, trim: true, default: 'Global' },
  primaryNoun: { type: String, index: true, trim: true, default: null },
  secondaryNoun: { type: String, index: true, trim: true, default: null },
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.20-hybrid' }
}, {
  timestamps: true,
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 });
articleSchema.index({ analysisType: 1, publishedAt: -1 });
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });
articleSchema.index({ country: 1, analysisType: 1, publishedAt: -1 });
// Index for vector clustering lookup
articleSchema.index({ clusterTopicVector: 1, publishedAt: -1 });

const Article = mongoose.model('Article', articleSchema);


// --- API Routes ---

// GET / - Health Check (NOT protected)
// This route is NOT protected by checkAuth
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Gamut API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      'Hybrid Semantic Clustering (Gemini Topic + Cosine Similarity)',
      '7-Day Cluster Window',
      'Smart Feed De-duplication w/ Cluster Count',
      'Region & Article Type Filters'
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});


// --- Apply token check to ALL OTHER API routes ---
// All routes *after* this line are protected
app.use('/api/', checkAuth);


// POST /api/fetch-news - Trigger background news fetch
let isFetchRunning = false;
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch trigger ignored: Fetch already running.');
    return res.status(429).json({ message: 'Fetch process already running. Please wait.' });
  }
  console.log(`📰 Manual fetch triggered via API by user: ${req.user.uid}`);
  isFetchRunning = true;

  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting in background.', timestamp: new Date().toISOString() });

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Manual fetch background process finished.');
     });
});


// --- USER PROFILE ROUTES (PROTECTED) ---

// GET /api/profile/me - Checks if a profile exists
app.get('/api/profile/me', async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.user.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles')
      .lean();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
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

// --- USER ACTIVITY LOGGING (PROTECTED) ---

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
    res.status(200).json({
      message: 'Read activity logged'
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-read:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});


// --- USER STATS ENDPOINT (PROTECTED) ---
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
             { $limit: 10 },
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          qualityDistribution_read: [
             { $match: { 'action': 'view_analysis', 'articleDetails.credibilityGrade': { $exists: true } } },
            { $group: { _id: '$articleDetails.credibilityGrade', count: { $sum: 1 } } },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],
          totalCounts: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ],
          topSources_read: [
            { $match: { 'action': 'view_analysis', 'articleDetails.source': { $exists: true, $ne: null } } },
            { $group: { _id: '$articleDetails.source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
            { $project: { _id: 0, source: '$_id', count: 1 } }
          ],
          sentimentDistribution_read: [
            { $match: { 'action': 'view_analysis', 'articleDetails.sentiment': { $exists: true, $ne: null } } },
            { $group: { _id: '$articleDetails.sentiment', count: { $sum: 1 } } },
            { $project: { _id: 0, sentiment: '$_id', count: 1 } }
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
      topSources_read: stats[0]?.topSources_read || [],
      sentimentDistribution_read: stats[0]?.sentimentDistribution_read || []
    };

    res.status(200).json(results);

  } catch (error) {
    console.error('Error in GET /api/profile/stats:', error.message);
    res.status(500).json({ error: 'Error fetching profile statistics' });
  }
});
// --- END OF USER ROUTES ---


// GET /api/articles - Fetch articles (SMART FEED)
app.get('/api/articles', async (req, res, next) => {
  try {
    const filters = {
      category: req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null,
      lean: req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null,
      quality: req.query.quality && req.query.quality !== 'All Quality Levels' ? String(req.query.quality) : null,
      sort: String(req.query.sort || 'Latest First'),
      limit: Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50),
      offset: Math.max(parseInt(req.query.offset) || 0, 0),
      region: req.query.region && req.query.region !== 'All' ? String(req.query.region) : null,
      articleType: req.query.articleType && req.query.articleType !== 'All Types' ? String(req.query.articleType) : null,
    };

    const matchStage = {};
    if (filters.category) matchStage.category = filters.category;
    if (filters.lean) matchStage.politicalLean = filters.lean;
    if (filters.region) matchStage.country = filters.region;
    
    if (filters.articleType === 'Hard News') {
      matchStage.analysisType = 'Full';
    } else if (filters.articleType === 'Opinion & Reviews') {
      matchStage.analysisType = 'SentimentOnly';
    }
    
    if (filters.quality && matchStage.analysisType !== 'SentimentOnly') {
        matchStage.analysisType = 'Full';
        matchStage.trustScore = matchStage.trustScore || {};
        const rangeMatch = filters.quality.match(/(\d+)-(\d+)/);
        if (rangeMatch) {
            matchStage.trustScore.$gte = parseInt(rangeMatch[1]);
            matchStage.trustScore.$lt = parseInt(rangeMatch[2]) + 1;
        } else if (filters.quality.includes('0-59')) {
             matchStage.trustScore = { $lt: 60 };
        }
    }

    let sortStage = { publishedAt: -1, createdAt: -1 };
    let postGroupSortStage = { "latestArticle.publishedAt": -1, "latestArticle.createdAt": -1 };
    
    switch(filters.sort) {
        case 'Highest Quality':
            sortStage = { trustScore: -1, publishedAt: -1 };
            postGroupSortStage = { "latestArticle.trustScore": -1, "latestArticle.publishedAt": -1 };
            break;
        case 'Most Covered':
            postGroupSortStage = { clusterCount: -1, "latestArticle.publishedAt": -1 };
            break;
        case 'Lowest Bias':
            sortStage = { biasScore: 1, publishedAt: -1 };
            postGroupSortStage = { "latestArticle.biasScore": 1, "latestArticle.publishedAt": -1 };
            break;
    }

    const aggregation = [
      { $match: matchStage },
      { $sort: sortStage },
      {
        $group: {
          _id: { $ifNull: [ "$clusterId", "$_id" ] },
          latestArticle: { $first: '$$ROOT' },
          clusterCount: { $sum: 1 }
        }
      },
      { $addFields: { "latestArticle.clusterCount": "$clusterCount" } },
      { $replaceRoot: { newRoot: '$latestArticle' } },
      { $sort: postGroupSortStage },
      {
        $facet: {
          articles: [
            { $skip: filters.offset },
            { $limit: filters.limit }
          ],
          pagination: [
            { $count: 'total' }
          ]
        }
      }
    ];

    const results = await Article.aggregate(aggregation).allowDiskUse(true);
    const articles = results[0]?.articles || [];
    const total = results[0]?.pagination[0]?.total || 0;

    res.status(200).json({
      articles,
      pagination: { total, limit: filters.limit, offset: filters.offset, hasMore: (filters.offset + articles.length) < total }
    });

  } catch (error) {
    console.error('❌ Error in GET /api/articles:', error.message);
    next(error);
  }
});

// POST /api/articles/:id/save - Save/Unsave Article
app.post('/api/articles/:id/save', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { uid } = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID' });
    }

    const article = await Article.findById(id, '_id').lean();
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const profile = await Profile.findOne({ userId: uid });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(id);
    const isSaved = profile.savedArticles.includes(articleObjectId);

    let updatedProfile;
    if (isSaved) {
      updatedProfile = await Profile.findOneAndUpdate(
        { userId: uid },
        { $pull: { savedArticles: articleObjectId } },
        { new: true }
      ).lean();
    } else {
      updatedProfile = await Profile.findOneAndUpdate(
        { userId: uid },
        { $addToSet: { savedArticles: articleObjectId } },
        { new: true }
      ).lean();
    }

    res.status(200).json({
      message: isSaved ? 'Article unsaved' : 'Article saved',
      savedArticles: updatedProfile.savedArticles
    });

  } catch (error) {
    console.error(`❌ Error in POST /api/articles/${req.params.id}/save:`, error.message);
    next(error);
  }
});

// GET /api/articles/saved - Get all saved articles
app.get('/api/articles/saved', async (req, res, next) => {
  try {
    const { uid } = req.user;
    
    const profile = await Profile.findOne({ userId: uid })
      .select('savedArticles')
      .populate({
        path: 'savedArticles',
        options: { sort: { publishedAt: -1 } }
      })
      .lean();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    res.status(200).json({ articles: profile.savedArticles || [] });

  } catch (error) {
    console.error('❌ Error in GET /api/articles/saved:', error.message);
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

    const articles = await Article.find({ clusterId: clusterIdNum })
      .sort({ trustScore: -1, publishedAt: -1 })
      .lean();

    const grouped = articles.reduce((acc, article) => {
      const lean = article.politicalLean;
      if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
      else if (lean === 'Center') acc.center.push(article);
      else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
      else if (lean === 'Not Applicable') acc.reviews.push(article);
      return acc;
    }, { left: [], center: [], right: [], reviews: [] });

    const totalArticles = articles.length;
    const fullAnalysisArticles = articles.filter(a => a.analysisType === 'Full');
    const fullCount = fullAnalysisArticles.length;
    
    const calculateAverage = (field) => fullCount > 0
      ? Math.round(fullAnalysisArticles.reduce((sum, a) => sum + (a[field] || 0), 0) / fullCount)
      : 0;
      
    const stats = {
      totalArticles,
      leftCount: grouped.left.length,
      centerCount: grouped.center.length,
      rightCount: grouped.right.length,
      reviewCount: grouped.reviews.length,
      averageBias: calculateAverage('biasScore'),
      averageTrust: calculateAverage('trustScore')
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


// --- Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle (Hybrid Clustering v2.20)...');
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

            if (analysis.isJunk) {
                stats.skipped_junk++;
                console.log(`🚮 Skipping junk/ad: ${article.title.substring(0, 50)}...`);
                continue;
            }
            
            // --- 4. Prepare Data ---
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
              clusterTopicVector: [], // Will be set below
              country: analysis.country,
              primaryNoun: analysis.primaryNoun,
              secondaryNoun: analysis.secondaryNoun,
              keyFindings: analysis.keyFindings,
              recommendations: analysis.recommendations,
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };
            
            // --- 5. HYBRID CLUSTERING LOGIC ---
            
            // Find the max clusterId ONCE for potential use
            const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
            const nextNewClusterId = (maxIdDoc?.clusterId || 0) + 1;

            if (newArticleData.clusterTopic) {
                // This is a "Hard News" article with a topic
                
                // 5.1. Generate the vector for the topic
                newArticleData.clusterTopicVector = await clusteringService.getEmbedding(newArticleData.clusterTopic);

                // 5.2. Find candidate articles from the last 7 days
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                const candidates = await Article.find({
                    publishedAt: { $gte: sevenDaysAgo },
                    clusterTopicVector: { $exists: true, $ne: [] } // Find articles that HAVE a vector
                }, { clusterId: 1, clusterTopicVector: 1 }).lean();

                // 5.3. Find the best semantic match
                // --- THIS IS THE FIX: Added 'await' ---
                const bestMatch = await clusteringService.findBestMatch(newArticleData.clusterTopicVector, candidates);

                if (bestMatch) {
                    // Found a strong match! Use its clusterId.
                    newArticleData.clusterId = bestMatch.clusterId;
                } else {
                    // No strong match. This is a new cluster.
                    newArticleData.clusterId = nextNewClusterId;
                    console.log(`Assigning NEW clusterId [${newArticleData.clusterId}] for topic: "${newArticleData.clusterTopic}"`);
                }
            } else {
                // This is an Opinion, Review, or un-clusterable article.
                // Give it its own unique clusterId so it doesn't group with anything.
                newArticleData.clusterId = nextNewClusterId;
            }
            // --- (End Clustering Logic) ---

            // 6. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (Cluster: ${savedArticle.clusterId})`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            await sleep(31000);
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
// We will set these up *after* the server is live
function setupCronJobs() {
  console.log('🕒 News fetch scheduled: Every 30 minutes');
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

  console.log('🗑️ Cleanup scheduled: Daily at 2 AM');
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
}

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

// --- NEW STARTUP LOGIC ---
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

console.log('🟡 Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
    
    // Start the server *after* MongoDB is connected
    const server = app.listen(PORT, HOST, () => {
      console.log(`\n🚀 Server listening on host ${HOST}, port ${PORT}`);
      console.log(`🔗 Health Check: http://localhost:${PORT}/`);
      console.log(`API available at /api`);
      
      // Setup cron jobs now that server is live
      setupCronJobs(); 
    });

    // Graceful shutdown logic
    const gracefulShutdown = async (signal) => {
      console.log(`\n👋 ${signal} received. Initiating graceful shutdown...`);
      // Stop the server from accepting new connections
      server.close(async () => {
        console.log('🔌 HTTP server closed.');
        try {
          // Close MongoDB connection
          await mongoose.connection.close();
          console.log('💾 MongoDB connection closed.');
          console.log('✅ Shutdown complete.');
          process.exit(0);
        } catch (err) {
          console.error('❌ Error during graceful shutdown:', err);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    // If Mongo connection fails on startup, exit the process
    process.exit(1); 
  });

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB runtime error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected.');
});
// --- END NEW STARTUP LOGIC ---
