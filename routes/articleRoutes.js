// routes/articleRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// Models
const Article = require('../models/articleModel');
const Profile = require('../models/profileModel');
const ActivityLog = require('../models/activityLogModel');
const Cache = require('../models/cacheModel'); 

// --- Helper: Merge & Deduplicate Arrays ---
const mergeResults = (arr1, arr2) => {
    const map = new Map();
    [...arr1, ...arr2].forEach(item => {
        // Use string ID as key to ensure uniqueness
        const id = item._id.toString();
        if (!map.has(id)) {
            map.set(id, item);
        }
    });
    return Array.from(map.values());
};

// --- 1. Trending Topics (MongoDB Cached) ---
router.get('/trending', async (req, res) => {
  try {
    const CACHE_KEY = 'trending_topics';
    
    // A. Check Database Cache
    const cachedDoc = await Cache.findOne({ key: CACHE_KEY }).lean();
    
    if (cachedDoc) {
        res.set('Cache-Control', 'public, max-age=1800'); 
        return res.status(200).json({ topics: cachedDoc.data });
    }

    // B. Miss! Calculate from scratch
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

    // C. Save to Database Cache
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins
    
    await Cache.findOneAndUpdate(
        { key: CACHE_KEY },
        { data: trending || [], expiresAt },
        { upsert: true, new: true }
    );

    res.set('Cache-Control', 'public, max-age=1800'); 
    res.status(200).json({ topics: trending || [] });

  } catch (error) {
    console.error("Trending Error:", error);
    res.status(500).json({ error: 'Error fetching trending' });
  }
});

// --- 2. Search (Enhanced Hybrid: Text + Fuzzy Regex) ---
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.trim().length === 0) return res.status(400).json({ error: 'Query required' });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const cleanQuery = query.trim();

    // STRATEGY 1: Strict Text Search (Good for ranking)
    // Uses the text index we created in the Model.
    const textPromise = Article.find(
      { $text: { $search: cleanQuery } },
      { score: { $meta: 'textScore' } }
    )
    .sort({ score: { $meta: 'textScore' }, publishedAt: -1 })
    .limit(limit)
    .lean();

    // STRATEGY 2: Flexible Regex Search (Good for partials/typos)
    // "Poli" will match "Politics" here, whereas Text Search might miss it.
    // We search Headlines and Topics specifically.
    const regex = new RegExp(cleanQuery, 'i'); // 'i' = case insensitive
    const regexPromise = Article.find({
        $or: [
            { headline: regex },
            { clusterTopic: regex },
            { category: regex }
        ]
    })
    .sort({ publishedAt: -1 })
    .limit(limit)
    .lean();

    // Run both in parallel for speed
    const [textResults, regexResults] = await Promise.all([textPromise, regexPromise]);

    // Merge results (Text results first as they are usually more relevant)
    let combined = mergeResults(textResults, regexResults);

    // Manual Pagination Handling since we merged two queries
    const total = combined.length; // Approximate total of current batch
    
    // Slice for the requested page if we have a lot (though we limited db queries already)
    // This is a simple approximation for the hybrid approach
    const results = combined.slice(0, limit).map(a => ({ ...a, clusterCount: 1 }));

    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json({ articles: results, pagination: { total } });

  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- 3. "Balanced For You" Feed ---
router.get('/articles/for-you', async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    const userId = req.user.uid;

    const logs = await ActivityLog.aggregate([
      { $match: { userId: userId, action: 'view_analysis' } },
      { $sort: { timestamp: -1 } },
      { $limit: 50 },
      { 
        $lookup: { 
          from: 'articles', 
          localField: 'articleId', 
          foreignField: '_id', 
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
        Article.find({ category: favoriteCategory, politicalLean: usualLean })
            .sort({ publishedAt: -1 })
            .limit(5)
            .lean(),
        Article.find({ category: favoriteCategory, politicalLean: { $in: challengeLeans } })
            .sort({ publishedAt: -1 })
            .limit(5)
            .lean()
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
      const lean = article.politicalLean || 'Not Applicable';
      
      if (['Left', 'Left-Leaning'].includes(lean)) {
          acc.left.push(article);
      } else if (lean === 'Center') {
          acc.center.push(article);
      } else if (['Right-Leaning', 'Right'].includes(lean)) {
          acc.right.push(article);
      } else {
          acc.reviews.push(article);
      }
      return acc;
    }, { left: [], center: [], right: [], reviews: [] }); 

    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json({ ...grouped, stats: { total: articles.length } });

  } catch (error) {
    console.error("Cluster Error:", error);
    res.status(500).json({ error: 'Cluster fetch error' });
  }
});

// --- 7. Main Feed (Cached) ---
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
    
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ articles: results[0]?.articles || [], pagination: { total: results[0]?.pagination[0]?.total || 0 } });

  } catch (error) {
    console.error("Feed Error:", error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
