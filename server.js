// server.js (v2.40 - Added Search Endpoint)
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
const Profile = require('./models/profileModel');
const ActivityLog = require('./models/activityLogModel');
const Article = require('./models/articleModel');

// --- Helper Functions ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

// --- Apply Middleware ---
app.use('/api/', checkAppCheck); 
app.use('/api/', checkAuth);


// ================= ROUTES =================

// --- 1. Profile Routes ---

// GET Profile
app.get('/api/profile/me', async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.user.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles')
      .lean();
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.status(200).json(profile);
  } catch (error) {
    console.error("Profile Error:", error);
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// POST Create Profile
app.post('/api/profile', async (req, res) => {
  try {
    const { username } = req.body;
    const { uid, email } = req.user; 

    if (!username || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    const cleanUsername = username.trim();

    const existingUsername = await Profile.findOne({ username: cleanUsername }).lean();
    if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

    const existingProfile = await Profile.findOne({ userId: uid }).lean();
    if (existingProfile) return res.status(409).json({ error: 'Profile already exists' });

    const newProfile = new Profile({ userId: uid, email: email, username: cleanUsername });
    await newProfile.save();
    res.status(201).json(newProfile);

  } catch (error) {
    console.error('Error in POST /api/profile:', error.message);
    if (error.code === 11000) return res.status(409).json({ error: 'Profile exists.' });
    res.status(500).json({ error: 'Error creating profile' });
  }
});

// Weekly Digest
app.get('/api/profile/weekly-digest', async (req, res) => {
  try {
    const userId = req.user.uid;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const recentLogs = await ActivityLog.aggregate([
      { $match: { userId: userId, action: 'view_analysis', timestamp: { $gte: sevenDaysAgo } } },
      { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'article' } },
      { $unwind: '$article' },
      { $project: { lean: '$article.politicalLean', category: '$article.category', topic: '$article.clusterTopic' } }
    ]);

    if (!recentLogs || recentLogs.length < 5) {
      return res.status(200).json({ status: 'Insufficient Data', message: "Read more articles to unlock your Weekly Pulse." });
    }

    let score = 0;
    const leanCounts = {};
    const categoryCounts = {};

    recentLogs.forEach(log => {
      leanCounts[log.lean] = (leanCounts[log.lean] || 0) + 1;
      if (log.lean === 'Left') score -= 2;
      else if (log.lean === 'Left-Leaning') score -= 1;
      else if (log.lean === 'Right-Leaning') score += 1;
      else if (log.lean === 'Right') score += 2;
      if (log.category) categoryCounts[log.category] = (categoryCounts[log.category] || 0) + 1;
    });

    const avgScore = score / recentLogs.length;
    let status = 'Balanced';
    let bubbleType = null; 
    
    if (avgScore <= -0.8) { status = 'Left Bubble'; bubbleType = 'Left'; }
    else if (avgScore >= 0.8) { status = 'Right Bubble'; bubbleType = 'Right'; }

    let recommendation = null;
    if (bubbleType) {
      const topCategory = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0] || 'General';
      const targetLeans = bubbleType === 'Left' ? ['Right', 'Right-Leaning', 'Center'] : ['Left', 'Left-Leaning', 'Center'];
      
      recommendation = await Article.findOne({
        category: topCategory,
        politicalLean: { $in: targetLeans },
        trustScore: { $gt: 75 }
      })
      .sort({ publishedAt: -1 })
      .select('headline summary politicalLean source _id')
      .lean();
    }

    res.status(200).json({
      status,
      avgScore,
      articleCount: recentLogs.length,
      recommendation,
      topCategory: Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0]
    });

  } catch (error) {
    console.error("Weekly Digest Error:", error);
    res.status(500).json({ error: 'Error generating digest' });
  }
});


// --- 2. Article Actions ---

// Save/Unsave Article
app.post('/api/articles/:id/save', async (req, res) => {
    try {
        const { id } = req.params;
        const { uid } = req.user;
        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid article ID' });

        const articleObjectId = new mongoose.Types.ObjectId(id);
        const profile = await Profile.findOne({ userId: uid });
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        const isSaved = profile.savedArticles.includes(articleObjectId);
        let updatedProfile;
        
        if (isSaved) {
            updatedProfile = await Profile.findOneAndUpdate({ userId: uid }, { $pull: { savedArticles: articleObjectId } }, { new: true }).lean();
        } else {
            updatedProfile = await Profile.findOneAndUpdate({ userId: uid }, { $addToSet: { savedArticles: articleObjectId } }, { new: true }).lean();
        }
        res.status(200).json({ message: isSaved ? 'Article unsaved' : 'Article saved', savedArticles: updatedProfile.savedArticles });
    } catch (error) {
        console.error("Save Error:", error);
        res.status(500).json({ error: 'Error saving article' });
    }
});

// Get Saved Articles
app.get('/api/articles/saved', async (req, res) => {
  try {
    const { uid } = req.user;
    const profile = await Profile.findOne({ userId: uid })
      .select('savedArticles')
      .populate({
        path: 'savedArticles',
        options: { sort: { publishedAt: -1 } } 
      })
      .lean();

    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.status(200).json({ articles: profile.savedArticles || [] });
  } catch (error) {
    console.error('Error in GET /api/articles/saved:', error.message);
    res.status(500).json({ error: 'Error loading saved articles' });
  }
});


// --- 3. Activity Logging ---

app.post('/api/activity/log-view', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId) return res.status(400).json({ error: 'ID required' });
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_analysis' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesViewedCount: 1 } });
    res.status(200).json({ message: 'Logged' });
  } catch (error) { res.status(500).json({ error: 'Log error' }); }
});

app.post('/api/activity/log-compare', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { comparisonsViewedCount: 1 } });
    res.status(200).json({ message: 'Logged' });
  } catch (error) { res.status(500).json({ error: 'Log error' }); }
});

app.post('/api/activity/log-share', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesSharedCount: 1 } });
    res.status(200).json({ message: 'Logged' });
  } catch (error) { res.status(500).json({ error: 'Log error' }); }
});

app.post('/api/activity/log-read', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'read_external' });
    res.status(200).json({ message: 'Logged' });
  } catch (error) { res.status(500).json({ error: 'Log error' }); }
});


// --- 4. Data Fetching Routes ---

// NEW: Search Endpoint
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim().length === 0) return res.status(400).json({ error: 'Query required' });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    // MongoDB Text Search with Ranking
    const articles = await Article.find(
      { $text: { $search: query } },
      { score: { $meta: 'textScore' } }
    )
    .sort({ score: { $meta: 'textScore' }, publishedAt: -1 }) // Sort by Relevance then Date
    .skip(offset)
    .limit(limit)
    .lean();

    const total = await Article.countDocuments({ $text: { $search: query } });

    // Mark these as "Full" results for the UI
    const results = articles.map(a => ({ ...a, clusterCount: 1 })); // Default to 1 count for search

    res.status(200).json({ articles: results, pagination: { total } });
  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({ error: 'Search failed' });
  }
});


// "Balanced For You" Feed
app.get('/api/articles/for-you', async (req, res) => {
  try {
    const userId = req.user.uid;
    const logs = await ActivityLog.aggregate([
      { $match: { userId: userId, action: 'view_analysis' } },
      { $sort: { timestamp: -1 } },
      { $limit: 50 },
      { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'article' } },
      { $unwind: '$article' }
    ]);

    let favoriteCategory = 'Technology'; 
    let usualLean = 'Center';

    if (logs.length > 0) {
      const cats = {}; const leans = {};
      logs.forEach(l => {
        if(l.article.category) cats[l.article.category] = (cats[l.article.category] || 0) + 1;
        if(l.article.politicalLean) leans[l.article.politicalLean] = (leans[l.article.politicalLean] || 0) + 1;
      });
      favoriteCategory = Object.keys(cats).sort((a,b) => cats[b] - cats[a])[0];
      usualLean = Object.keys(leans).sort((a,b) => leans[b] - leans[a])[0];
    }

    let challengeLeans = [];
    if (['Left', 'Left-Leaning'].includes(usualLean)) challengeLeans = ['Right', 'Right-Leaning', 'Center'];
    else if (['Right', 'Right-Leaning'].includes(usualLean)) challengeLeans = ['Left', 'Left-Leaning', 'Center'];
    else challengeLeans = ['Left', 'Right'];

    const comfortArticles = await Article.find({ category: favoriteCategory, politicalLean: usualLean }).sort({ publishedAt: -1 }).limit(5).lean();
    const challengeArticles = await Article.find({ category: favoriteCategory, politicalLean: { $in: challengeLeans } }).sort({ publishedAt: -1 }).limit(5).lean();

    const result = [
      ...comfortArticles.map(a => ({ ...a, suggestionType: 'Comfort' })),
      ...challengeArticles.map(a => ({ ...a, suggestionType: 'Challenge' }))
    ];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }

    res.status(200).json({ articles: result, meta: { basedOnCategory: favoriteCategory, usualLean: usualLean } });

  } catch (error) {
    console.error("For You Error:", error);
    res.status(500).json({ error: 'Error generating recommendations' });
  }
});


// Standard Feed Route
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
    console.error("Feed Error:", error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cluster Fetch
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

    res.status(200).json({ ...grouped, stats: { total: articles.length } });
  } catch (error) {
    next(error);
  }
});

// Stats
app.get('/api/profile/stats', async (req, res) => {
  try {
    const userId = req.user.uid;
    const stats = await ActivityLog.aggregate([
      { $match: { userId: userId } },
      { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'articleDetails' } },
      { $unwind: { path: '$articleDetails', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          dailyCounts: [
            { $match: { action: 'view_analysis' } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } },
            { $sort: { '_id': 1 } }, { $project: { _id: 0, date: '$_id', count: 1 } }
          ],
          leanDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          leanDistribution_shared: [
             { $match: { 'action': 'share_article' } },
            { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          categoryDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.category', count: { $sum: 1 } } },
             { $sort: { count: -1 } }, { $limit: 10 },
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          qualityDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.credibilityGrade', count: { $sum: 1 } } },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],
          totalCounts: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ],
          topSources_read: [
            { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.source', count: { $sum: 1 } } },
            { $sort: { count: -1 } }, { $limit: 10 },
            { $project: { _id: 0, source: '$_id', count: 1 } }
          ],
          sentimentDistribution_read: [
            { $match: { 'action': 'view_analysis' } },
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
    console.error('Stats Error:', error);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});


// ==========================================

// --- Background Logic (Parallelized) ---
let isFetchRunning = false;
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) return res.status(429).json({ message: 'Running' });
  isFetchRunning = true;
  geminiService.isRateLimited = false;
  res.status(202).json({ message: 'Started' });
  fetchAndAnalyzeNews().finally(() => { isFetchRunning = false; });
});

async function fetchAndAnalyzeNews() {
  console.log('🔄 Fetching news...');
  try {
    const rawArticles = await newsService.fetchNews(); 
    if (rawArticles.length === 0) return;

    // --- PARALLEL PROCESSING (Batch Size 3 for 4 Keys) ---
    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        console.log(`⚡ Processing batch ${i/BATCH_SIZE + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Small safety buffer if rate limited
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
        
        // Parallelize Embedding + Analysis (if possible, though usually sequential is safer for token limits)
        // We stick to sequential inside the article to ensure we don't embed junk
        const analysis = await geminiService.analyzeArticle(article);
        if (analysis.isJunk) return;

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
            analysisVersion: Article.schema.path('analysisVersion').defaultValue,
            embedding: embedding || []
        };
        
        newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        await Article.create(newArticleData);
        console.log(`✅ Saved: ${newArticleData.headline.substring(0, 30)}...`);

    } catch (error) {
        console.error(`❌ Article Error: ${error.message}`);
    }
}

cron.schedule('*/30 * * * *', () => { if(!isFetchRunning) { isFetchRunning = true; geminiService.isRateLimited = false; fetchAndAnalyzeNews().finally(() => isFetchRunning = false); } });

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
