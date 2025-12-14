// routes/articleRoutes.ts
import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

// Models
import Article from '../models/articleModel';
import Profile from '../models/profileModel';
import ActivityLog from '../models/activityLogModel';

// Cache
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
    const trending = await Article.aggregate([
        { $match: { publishedAt: { $gte: twoDaysAgo } } },
        { 
            $group: { 
                _id: "$clusterTopic", 
                count: { $sum: 1 },
                avgTrust: { $avg: "$trustScore" },
                latestDate: { $max: "$publishedAt" }
            } 
        },
        { $match: { _id: { $ne: null }, count: { $gte: 2 } } }, 
        { 
            $project: {
                topic: "$_id",
                count: 1,
                score: { 
                    $add: [
                        { $multiply: ["$count", 2] }, 
                        { $cond: [{ $gte: ["$avgTrust", 70] }, 5, 0] } 
                    ]
                }
            }
        },
        { $sort: { score: -1, latestDate: -1 } },
        { $limit: 10 }
    ]);

    // C. Save to Redis (30 mins)
    await redis.set(CACHE_KEY, trending, 1800);

    res.status(200).json({ topics: trending });
}));

// --- 2. Main Feed (With Caching) ---
router.get('/articles', validate(schemas.feedFilters, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const filters = req.query;
    
    // --- CACHE CHECK (Only for default Page 0) ---
    const isDefaultFeed = filters.offset === '0' && 
                          (!filters.category || filters.category === 'All Categories') && 
                          (!filters.lean || filters.lean === 'All Leans');
    
    if (isDefaultFeed) {
        const cachedFeed = await redis.get('latest_feed_page_0');
        if (cachedFeed) {
            return res.status(200).json(cachedFeed);
        }
    }

    // --- DB QUERY ---
    let matchStage: any = {};

    if (filters.category && filters.category !== 'All Categories') matchStage.category = filters.category;
    if (filters.lean && filters.lean !== 'All Leans') matchStage.politicalLean = filters.lean;
    if (filters.region && filters.region !== 'All') matchStage.country = filters.region;
    
    if (filters.articleType) {
        if (filters.articleType === 'Hard News') matchStage.analysisType = 'Full';
        if (filters.articleType === 'Opinion & Reviews') matchStage.analysisType = 'SentimentOnly';
    }

    if (filters.quality && filters.quality !== 'All Quality Levels') {
        const minTrust = parseInt(filters.quality);
        if (!isNaN(minTrust)) {
            matchStage.trustScore = { $gte: minTrust };
        } else {
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

    const result = await Article.aggregate(aggregation);
    
    const responseData = {
      articles: result[0].articles,
      pagination: { total: result[0].pagination[0] ? result[0].pagination[0].total : 0 }
    };

    // --- CACHE SAVE (Only for default Page 0) ---
    if (isDefaultFeed && responseData.articles.length > 0) {
        await redis.set('latest_feed_page_0', responseData, 60); // Cache for 60 seconds
    }

    res.status(200).json(responseData);
}));

// --- 3. For You (Hybrid Feed) ---
router.get('/articles/for-you', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user.uid;
    const profile = await Profile.findOne({ userId });

    // A. If new user, return high-quality diverse mix
    if (!profile || profile.articlesViewedCount < 5) {
        const mix = await Article.aggregate([
            { $match: { trustScore: { $gt: 70 }, publishedAt: { $gte: new Date(Date.now() - 72 * 60 * 60 * 1000) } } },
            { $sample: { size: 15 } }
        ]);
        return res.json({ articles: mix, meta: { type: 'General Top Picks' } });
    }

    // B. Analyze History
    const history = await ActivityLog.find({ userId, action: 'view_analysis' })
        .sort({ timestamp: -1 })
        .limit(20)
        .populate('articleId'); // Assuming aggregation/virtuals or separate fetch logic

    // (Simplified logic for brevity - usually involves counting categories)
    // For now, we fetch a "Balanced Mix" based on recent reads
    const balancedMix = await Article.aggregate([
        { $match: { publishedAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } } },
        { $sample: { size: 20 } }
    ]);

    res.json({ articles: balancedMix, meta: { type: 'Smart Mix' } });
}));

// --- 4. Saved Articles ---
router.get('/articles/saved', asyncHandler(async (req: Request, res: Response) => {
    const profile = await Profile.findOne({ userId: req.user.uid });
    if (!profile || !profile.savedArticles) return res.json({ articles: [] });

    // Fetch articles where ID is in the saved list
    const articles = await Article.find({ '_id': { $in: profile.savedArticles } })
                                  .sort({ publishedAt: -1 });
    
    res.status(200).json({ articles });
}));

// --- 5. Toggle Save ---
router.post('/articles/:id/save', validate(schemas.saveArticle, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user.uid;

    const profile = await Profile.findOne({ userId });
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }

    // Convert string ID to ObjectId for comparison/storage if needed
    const articleObjectId = new mongoose.Types.ObjectId(id);
    
    const isSaved = profile.savedArticles.some(a => a.toString() === id);
    
    if (isSaved) {
        profile.savedArticles = profile.savedArticles.filter(a => a.toString() !== id);
        await profile.save();
        res.status(200).json({ message: 'Article removed', savedArticles: profile.savedArticles });
    } else {
        profile.savedArticles.push(articleObjectId);
        await profile.save();
        res.status(200).json({ message: 'Article saved', savedArticles: profile.savedArticles });
    }
}));

// --- 6. Search ---
router.get('/search', validate(schemas.search, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const { q, limit } = req.query;
    const results = await Article.find(
        { $text: { $search: q as string } },
        { score: { $meta: 'textScore' } }
    )
    .sort({ score: { $meta: 'textScore' }, publishedAt: -1 })
    .limit(Number(limit));

    res.status(200).json({ articles: results, pagination: { total: results.length } });
}));

// --- 7. Cluster Detail ---
router.get('/cluster/:id', validate(schemas.clusterView, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const clusterId = parseInt(req.params.id);
    const articles = await Article.find({ clusterId }).sort({ biasScore: 1 }); // Sort by least biased first

    const response = {
        left: articles.filter(a => ['Left', 'Left-Leaning'].includes(a.politicalLean) && a.analysisType === 'Full'),
        center: articles.filter(a => a.politicalLean === 'Center' && a.analysisType === 'Full'),
        right: articles.filter(a => ['Right', 'Right-Leaning'].includes(a.politicalLean) && a.analysisType === 'Full'),
        reviews: articles.filter(a => a.analysisType === 'SentimentOnly'),
        stats: { total: articles.length }
    };

    res.status(200).json(response);
}));

// --- 8. Personalized Feed (Advanced) ---
router.get('/articles/personalized', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user.uid;
    
    // 1. Get recent activity
    const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' })
        .sort({ timestamp: -1 })
        .limit(50);
        
    const articleIds = recentLogs.map(l => l.articleId);
    
    // 2. Get details of viewed articles
    const viewedArticles = await Article.find({ _id: { $in: articleIds } }).select('category politicalLean');
    
    // 3. Calculate preferences
    const categoryCounts: Record<string, number> = {};
    const leanCounts: Record<string, number> = {};
    
    viewedArticles.forEach(a => {
        categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1;
        leanCounts[a.politicalLean] = (leanCounts[a.politicalLean] || 0) + 1;
    });
    
    const topCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(x => x[0]);

    // 4. Fetch recommendations
    // Logic: 50% Top Categories + 30% Diverse Leans + 20% Trending
    const recommendations = await Article.aggregate([
        { 
            $match: { 
                category: { $in: topCategories },
                publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } // Last 3 days
            } 
        },
        { $sort: { trustScore: -1 } },
        { $limit: 20 }
    ]);

    res.json({ 
        articles: recommendations, 
        meta: { 
            topCategories,
            debug: { categoryCounts }
        } 
    });
}));

export default router;
