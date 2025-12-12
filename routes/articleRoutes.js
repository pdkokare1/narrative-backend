// routes/articleRoutes.js (FINAL v5.0 - Redis Caching)
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler'); 

// Models
const Article = require('../models/articleModel');
const Profile = require('../models/profileModel');
const ActivityLog = require('../models/activityLogModel');

// Cache
const redis = require('../utils/redisClient'); // <--- NEW: Import Redis

// --- Helper: Merge & Deduplicate Arrays ---
const mergeResults = (arr1, arr2) => {
    const map = new Map();
    [...arr1, ...arr2].forEach(item => {
        const id = item._id.toString();
        if (!map.has(id)) {
            map.set(id, item);
        }
    });
    return Array.from(map.values());
};

// --- 1. Smart Trending Topics (Redis Cached) ---
router.get('/trending', asyncHandler(async (req, res) => {
    const CACHE_KEY = 'trending_topics_smart';
    
    // A. Check Redis
    const cachedData = await redis.get(CACHE_KEY);
    if (cachedData) {
        res.set('Cache-Control', 'public, max-age=1800'); 
        return res.status(200).json({ topics: cachedData });
    }

    // B. Calculate Logic (48h Window)
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    
    const rawStats = await Article.aggregate([
      { 
          $match: { 
              publishedAt: { $gte: twoDaysAgo }, 
              clusterTopic: { $ne: null } 
          } 
      },
      { 
          $group: { 
              _id: "$clusterTopic", 
              count: { $sum: 1 },
              latestDate: { $max: "$publishedAt" } 
          } 
      },
      { $match: { count: { $gte: 2 } } } 
    ]);

    // Calculate Velocity Score
    const now = Date.now();
    const scoredTopics = rawStats.map(t => {
        const hoursAgo = (now - new Date(t.latestDate).getTime()) / (1000 * 60 * 60);
        const velocityScore = t.count * (10 / (hoursAgo + 2)); 
        return { topic: t._id, count: t.count, score: velocityScore };
    });

    scoredTopics.sort((a, b) => b.score - a.score);
    const topTopics = scoredTopics.slice(0, 7);

    // C. Save to Redis (TTL: 1800s = 30 mins)
    await redis.set(CACHE_KEY, topTopics, 1800);

    res.set('Cache-Control', 'public, max-age=1800'); 
    res.status(200).json({ topics: topTopics });
}));

// --- 2. Search (Hybrid) ---
router.get('/search', asyncHandler(async (req, res) => {
    const query = req.query.q;
    if (!query || query.trim().length === 0) {
        res.status(400);
        throw new Error('Query required');
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const cleanQuery = query.trim();

    const textPromise = Article.find(
      { $text: { $search: cleanQuery } },
      { score: { $meta: 'textScore' } }
    ).sort({ score: { $meta: 'textScore' }, publishedAt: -1 }).limit(limit).lean();

    const regex = new RegExp(cleanQuery, 'i');
    const regexPromise = Article.find({
        $or: [{ headline: regex }, { clusterTopic: regex }, { category: regex }]
    }).sort({ publishedAt: -1 }).limit(limit).lean();

    const [textResults, regexResults] = await Promise.all([textPromise, regexPromise]);
    let combined = mergeResults(textResults, regexResults);
    const total = combined.length;
    
    const results = combined.slice(0, limit).map(a => ({ ...a, clusterCount: 1 }));

    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json({ articles: results, pagination: { total } });
}));

// --- 3. "Balanced For You" Feed ---
router.get('/articles/for-you', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    const userId = req.user.uid;

    const logs = await ActivityLog.aggregate([
      { $match: { userId: userId, action: 'view_analysis' } },
      { $sort: { timestamp: -1 } },
      { $limit: 50 },
      { 
        $lookup: { 
          from: 'articles', localField: 'articleId', foreignField: '_id', 
          pipeline: [{ $project: { category: 1, politicalLean: 1 } }], 
          as: 'article' 
        } 
      },
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
      const sortedCats = Object.keys(cats).sort((a,b) => cats[b] - cats[a]);
      const sortedLeans = Object.keys(leans).sort((a,b) => leans[b] - leans[a]);
      if (sortedCats.length) favoriteCategory = sortedCats[0];
      if (sortedLeans.length) usualLean = sortedLeans[0];
    }

    let challengeLeans = [];
    if (['Left', 'Left-Leaning'].includes(usualLean)) challengeLeans = ['Right', 'Right-Leaning', 'Center'];
    else if (['Right', 'Right-Leaning'].includes(usualLean)) challengeLeans = ['Left', 'Left-Leaning', 'Center'];
    else challengeLeans = ['Left', 'Right'];

    const [comfortArticles, challengeArticles] = await Promise.all([
        Article.find({ category: favoriteCategory, politicalLean: usualLean }).sort({ publishedAt: -1 }).limit(5).lean(),
        Article.find({ category: favoriteCategory, politicalLean: { $in: challengeLeans } }).sort({ publishedAt: -1 }).limit(5).lean()
    ]);

    const result = [
      ...comfortArticles.map(a => ({ ...a, suggestionType: 'Comfort' })),
      ...challengeArticles.map(a => ({ ...a, suggestionType: 'Challenge' }))
    ];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }

    res.status(200).json({ articles: result, meta: { basedOnCategory: favoriteCategory, usualLean: usualLean } });
}));

// --- 4. Save/Unsave Article ---
router.post('/articles/:id/save', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { uid } = req.user;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400);
        throw new Error('Invalid article ID');
    }

    const articleObjectId = new mongoose.Types.ObjectId(id);
    const profile = await Profile.findOne({ userId: uid });
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }

    const isSaved = profile.savedArticles.includes(articleObjectId);
    let updatedProfile;
    
    if (isSaved) {
        updatedProfile = await Profile.findOneAndUpdate({ userId: uid }, { $pull: { savedArticles: articleObjectId } }, { new: true }).lean();
    } else {
        updatedProfile = await Profile.findOneAndUpdate({ userId: uid }, { $addToSet: { savedArticles: articleObjectId } }, { new: true }).lean();
    }
    res.status(200).json({ message: isSaved ? 'Article unsaved' : 'Article saved', savedArticles: updatedProfile.savedArticles });
}));

// --- 5. Get Saved Articles ---
router.get('/articles/saved', asyncHandler(async (req, res) => {
    const { uid } = req.user;
    const profile = await Profile.findOne({ userId: uid })
      .select('savedArticles')
      .populate({ path: 'savedArticles', options: { sort: { publishedAt: -1 } } })
      .lean();

    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }
    res.status(200).json({ articles: profile.savedArticles || [] });
}));

// --- 6. Cluster Fetch (Redis Cached) ---
router.get('/cluster/:clusterId', asyncHandler(async (req, res) => {
    const clusterIdNum = parseInt(req.params.clusterId);
    if (isNaN(clusterIdNum)) {
        res.status(400);
        throw new Error('Invalid cluster ID');
    }

    const CACHE_KEY = `cluster_view_${clusterIdNum}`;

    // A. Check Redis
    const cachedCluster = await redis.get(CACHE_KEY);
    if (cachedCluster) {
        res.set('Cache-Control', 'public, max-age=600');
        return res.status(200).json(cachedCluster);
    }

    // B. Query DB
    const articles = await Article.find({ clusterId: clusterIdNum }).sort({ trustScore: -1, publishedAt: -1 }).lean();

    const grouped = articles.reduce((acc, article) => {
      const lean = article.politicalLean || 'Not Applicable';
      if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
      else if (lean === 'Center') acc.center.push(article);
      else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
      else acc.reviews.push(article);
      return acc;
    }, { left: [], center: [], right: [], reviews: [] }); 

    const responseData = { ...grouped, stats: { total: articles.length } };

    // C. Save to Redis (TTL: 600s = 10 mins)
    await redis.set(CACHE_KEY, responseData, 600);

    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json(responseData);
}));

// --- 7. Main Feed ---
router.get('/articles', asyncHandler(async (req, res) => {
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
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ articles: results[0]?.articles || [], pagination: { total: results[0]?.pagination[0]?.total || 0 } });
}));

module.exports = router;
