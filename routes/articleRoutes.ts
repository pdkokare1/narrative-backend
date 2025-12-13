// routes/articleRoutes.ts
import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
// @ts-ignore
import asyncHandler from '../utils/asyncHandler';
// @ts-ignore
import validate from '../middleware/validate';
// @ts-ignore
import schemas from '../utils/validationSchemas';

// Models
import Article from '../models/articleModel';
import Profile from '../models/profileModel';
import ActivityLog from '../models/activityLogModel';

// Cache
// @ts-ignore
import redis from '../utils/redisClient';

const router = express.Router();

// --- Helper: Merge & Deduplicate Arrays ---
const mergeResults = (arr1: any[], arr2: any[]): any[] => {
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
router.get('/trending', asyncHandler(async (req: Request, res: Response) => {
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
    const scoredTopics = rawStats.map((t: any) => {
        const hoursAgo = (now - new Date(t.latestDate).getTime()) / (1000 * 60 * 60);
        const velocityScore = t.count * (10 / (hoursAgo + 2)); 
        return { topic: t._id, count: t.count, score: velocityScore };
    });

    scoredTopics.sort((a: any, b: any) => b.score - a.score);
    const topTopics = scoredTopics.slice(0, 7);

    // C. Save to Redis (TTL: 1800s = 30 mins)
    await redis.set(CACHE_KEY, topTopics, 1800);

    res.set('Cache-Control', 'public, max-age=1800'); 
    res.status(200).json({ topics: topTopics });
}));

// --- 2. Search (Hybrid, Validated & Cached) ---
router.get('/search', validate(schemas.search, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const { q, limit } = req.query as any; 
    const cleanQuery = q.trim().toLowerCase(); 

    const CACHE_KEY = `search:${cleanQuery}:${limit}`;

    const cachedSearch = await redis.get(CACHE_KEY);
    if (cachedSearch) {
        res.set('X-Cache', 'HIT'); 
        res.set('Cache-Control', 'public, max-age=3600');
        return res.status(200).json(cachedSearch);
    }

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
    
    const responsePayload = { articles: results, pagination: { total } };

    if (results.length > 0) {
        await redis.set(CACHE_KEY, responsePayload, 3600);
    }

    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json(responsePayload);
}));

// --- 3. "Balanced For You" Feed ---
router.get('/articles/for-you', asyncHandler(async (req: Request, res: Response) => {
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
      const cats: any = {}; const leans: any = {};
      logs.forEach((l: any) => {
        if(l.article.category) cats[l.article.category] = (cats[l.article.category] || 0) + 1;
        if(l.article.politicalLean) leans[l.article.politicalLean] = (leans[l.article.politicalLean] || 0) + 1;
      });
      const sortedCats = Object.keys(cats).sort((a,b) => cats[b] - cats[a]);
      const sortedLeans = Object.keys(leans).sort((a,b) => leans[b] - leans[a]);
      if (sortedCats.length) favoriteCategory = sortedCats[0];
      if (sortedLeans.length) usualLean = sortedLeans[0];
    }

    let challengeLeans: string[] = [];
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
router.post('/articles/:id/save', validate(schemas.saveArticle, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { uid } = req.user;

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
    res.status(200).json({ message: isSaved ? 'Article unsaved' : 'Article saved', savedArticles: updatedProfile?.savedArticles });
}));

// --- 5. Get Saved Articles ---
router.get('/articles/saved', asyncHandler(async (req: Request, res: Response) => {
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

// --- 6. Cluster Fetch ---
router.get('/cluster/:clusterId', validate(schemas.clusterView, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const { clusterId } = req.params; 
    const CACHE_KEY = `cluster_view_${clusterId}`;

    // A. Check Redis
    const cachedCluster = await redis.get(CACHE_KEY);
    if (cachedCluster) {
        res.set('Cache-Control', 'public, max-age=600');
        return res.status(200).json(cachedCluster);
    }

    // B. Query DB
    const articles = await Article.find({ clusterId: Number(clusterId) }).sort({ trustScore: -1, publishedAt: -1 }).lean();

    const grouped = articles.reduce((acc: any, article: any) => {
      const lean = article.politicalLean || 'Not Applicable';
      if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
      else if (lean === 'Center') acc.center.push(article);
      else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
      else acc.reviews.push(article);
      return acc;
    }, { left: [], center: [], right: [], reviews: [] }); 

    const responseData = { ...grouped, stats: { total: articles.length } };

    // C. Save to Redis
    await redis.set(CACHE_KEY, responseData, 600);

    res.set('Cache-Control', 'public, max-age=600');
    res.status(200).json(responseData);
}));

// --- 7. Main Feed ---
router.get('/articles', validate(schemas.feedFilters, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const filters = req.query as any;

    const matchStage: any = {};
    if (filters.category && filters.category !== 'All Categories') matchStage.category = filters.category;
    if (filters.lean && filters.lean !== 'All Leans') matchStage.politicalLean = filters.lean;
    if (filters.region && filters.region !== 'All') matchStage.country = filters.region;
    
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

    let sortStage: any = { publishedAt: -1, createdAt: -1 };
    let postGroupSortStage: any = { "latestArticle.publishedAt": -1 }; 
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
      { $facet: { articles: [{ $skip: Number(filters.offset) }, { $limit: Number(filters.limit) }], pagination: [{ $count: 'total' }] } }
    ];

    const results = await Article.aggregate(aggregation).allowDiskUse(true);
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json({ articles: results[0]?.articles || [], pagination: { total: results[0]?.pagination[0]?.total || 0 } });
}));

export default router;
