// routes/articleRoutes.js (FINAL v3.1 - With Caching)
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// Models
const Article = require('../models/articleModel');
const Profile = require('../models/profileModel');
const ActivityLog = require('../models/activityLogModel');

// --- CACHE CONFIGURATION ---
let trendingCache = {
  data: [],
  lastFetch: 0
};
const CACHE_DURATION = 30 * 60 * 1000; // 30 Minutes in milliseconds

// --- 1. Trending Topics (Cached) ---
router.get('/trending', async (req, res) => {
  try {
    const now = Date.now();

    // 1. Check if cache is valid
    if (trendingCache.data.length > 0 && (now - trendingCache.lastFetch < CACHE_DURATION)) {
      // Serve from RAM (Instant, Free)
      return res.status(200).json({ topics: trendingCache.data });
    }

    // 2. Cache expired or empty? Query Database (Slower, Costs money)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const trending = await Article.aggregate([
      { 
        $match: { 
          publishedAt: { $gte: oneDayAgo }, 
          clusterTopic: { $ne: null } 
        } 
      },
      { $group: { _id: "$clusterTopic", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 7 },
      { $project: { _id: 0, topic: "$_id", count: 1 } }
    ]);

    // 3. Update Cache
    trendingCache = {
      data: trending || [],
      lastFetch: now
    };

    console.log('🔄 Refreshed Trending Topics Cache');
    res.status(200).json({ topics: trendingCache.data });

  } catch (error) {
    console.error("Trending Error:", error);
    res.status(500).json({ error: 'Error fetching trending' });
  }
});

// --- 2. Search ---
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim().length === 0) return res.status(400).json({ error: 'Query required' });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const articles = await Article.find(
      { $text: { $search: query } },
      { score: { $meta: 'textScore' } }
    )
    .sort({ score: { $meta: 'textScore' }, publishedAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();

    const total = await Article.countDocuments({ $text: { $search: query } });
    const results = articles.map(a => ({ ...a, clusterCount: 1 })); 

    res.status(200).json({ articles: results, pagination: { total } });
  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- 3. "Balanced For You" Feed ---
router.get('/articles/for-you', async (req, res) => {
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

// --- 4. Save/Unsave Article ---
router.post('/articles/:id/save', async (req, res) => {
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

// --- 5. Get Saved Articles ---
router.get('/articles/saved', async (req, res) => {
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
    console.error('Error getting saved articles:', error.message);
    res.status(500).json({ error: 'Error loading saved articles' });
  }
});

// --- 6. Cluster Fetch ---
router.get('/cluster/:clusterId', async (req, res) => {
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
    console.error("Cluster Error:", error);
    res.status(500).json({ error: 'Cluster fetch error' });
  }
});

// --- 7. Main Feed ---
router.get('/articles', async (req, res) => {
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

module.exports = router;
