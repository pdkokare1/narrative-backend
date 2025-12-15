// src/routes/articleRoutes.ts
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import * as admin from 'firebase-admin';

// Models
import Article from '../models/articleModel';
import Profile from '../models/profileModel';
import ActivityLog from '../models/activityLogModel';

// Cache
import redis from '../utils/redisClient';

const router = express.Router();

// --- AUTH MIDDLEWARE (Internal) ---
// We define this here to ensure it applies to the specific routes that need it
const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
        try {
            const decoded = await admin.auth().verifyIdToken(token);
            req.user = decoded;
        } catch (e) {
            console.warn("Auth check failed in articleRoutes", e);
        }
    }
    next();
};

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
    
    const aggregation = [
        { 
            $match: { 
                publishedAt: { $gte: twoDaysAgo },
                clusterTopic: { $exists: true, $ne: null } 
            } 
        },
        { 
            $group: { 
                _id: "$clusterTopic", 
                count: { $sum: 1 },
                sampleScore: { $max: "$trustScore" } 
            } 
        },
        { $match: { count: { $gte: 3 } } }, 
        { $sort: { count: -1 } },
        { $limit: 10 }
    ];

    const results = await Article.aggregate(aggregation as any);
    
    const topics = results.map(r => ({
        topic: r._id,
        count: r.count,
        score: r.sampleScore
    }));

    // C. Save to Redis (30 mins)
    await redis.set(CACHE_KEY, topics, 1800);

    res.status(200).json({ topics });
}));

// --- 2. Intelligent Search (Fuzzy + Strict) ---
router.get('/search', validate(schemas.search, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.q as string).trim();
    const limit = parseInt(req.query.limit as string) || 12;
    
    if (!query) return res.status(200).json({ articles: [], pagination: { total: 0 } });

    const strictResults = await Article.find(
        { $text: { $search: query } },
        { score: { $meta: "textScore" } }
    )
    .sort({ score: { $meta: "textScore" }, publishedAt: -1 })
    .limit(limit)
    .lean();

    let finalResults = strictResults;
    
    if (strictResults.length < 5) {
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(safeQuery, 'i');

        const fuzzyResults = await Article.find({
            $or: [
                { headline: { $regex: regex } },
                { clusterTopic: { $regex: regex } }
            ],
            _id: { $nin: strictResults.map(r => r._id) }
        })
        .sort({ publishedAt: -1 })
        .limit(limit - strictResults.length)
        .lean();

        finalResults = [...strictResults, ...fuzzyResults];
    }

    res.status(200).json({ 
        articles: finalResults,
        pagination: { total: finalResults.length }
    });
}));

// --- 3. Main Feed (Filtered & Paginated) ---
router.get('/articles', validate(schemas.feedFilters, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const { category, lean, region, articleType, quality, sort, limit, offset } = req.query;
    
    const query: any = {};

    if (category && category !== 'All Categories') query.category = category;
    if (lean && lean !== 'All Leans') query.politicalLean = lean;
    
    if (region === 'India') query.country = 'India';
    else if (region === 'Global') query.country = { $ne: 'India' };

    if (articleType === 'Hard News') query.analysisType = 'Full';
    else if (articleType === 'Opinion & Reviews') query.analysisType = 'SentimentOnly';

    if (quality && quality !== 'All Quality Levels') {
        const gradeMap: Record<string, string[]> = {
            'A+ Excellent (90-100)': ['A+'],
            'A High (80-89)': ['A', 'A-'],
            'B Professional (70-79)': ['B+', 'B', 'B-'],
            'C Acceptable (60-69)': ['C+', 'C', 'C-'],
            'D-F Poor (0-59)': ['D+', 'D', 'D-', 'F', 'D-F']
        };
        const grades = gradeMap[quality as string];
        if (grades) query.credibilityGrade = { $in: grades };
    }

    let sortOptions: any = { publishedAt: -1 }; 
    if (sort === 'Highest Quality') sortOptions = { trustScore: -1 };
    else if (sort === 'Most Covered') sortOptions = { clusterCount: -1 }; 
    else if (sort === 'Lowest Bias') sortOptions = { biasScore: 1 }; 

    const articles = await Article.find(query)
        .sort(sortOptions)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();

    const total = await Article.countDocuments(query);

    res.status(200).json({ articles, pagination: { total } });
}));

// --- 4. "For You" Feed (The "Balanced" Algorithm) ---
router.get('/articles/for-you', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // FALLBACK 1: If no user logged in
    if (!req.user || !req.user.uid) {
        const standard = await Article.find({})
            .sort({ trustScore: -1, publishedAt: -1 })
            .limit(10).lean();
        return res.status(200).json({ articles: standard, meta: { reason: "Guest User" } });
    }

    const userId = req.user.uid;
    
    // 1. Get User's Bias History
    const history = await ActivityLog.find({ userId, action: 'view_analysis' })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();
    
    // FALLBACK 2: No History
    if (history.length === 0) {
        const standard = await Article.find({})
            .sort({ trustScore: -1, publishedAt: -1 })
            .limit(10).lean();
        return res.status(200).json({ articles: standard, meta: { reason: "No history" } });
    }

    // 2. Identify "Echo Chamber" risk
    const articleIds = history.map(h => h.articleId);
    const viewedDocs = await Article.find({ _id: { $in: articleIds } }).select('politicalLean category');
    
    const leanCounts: Record<string, number> = {};
    viewedDocs.forEach(d => { leanCounts[d.politicalLean] = (leanCounts[d.politicalLean] || 0) + 1; });
    
    let dominantLean = 'Center';
    let maxCount = 0;
    Object.entries(leanCounts).forEach(([lean, count]) => {
        if (count > maxCount) { maxCount = count; dominantLean = lean; }
    });

    // 3. Fetch "Challenger" Articles
    let targetLean = ['Center'];
    if (dominantLean.includes('Left')) targetLean = ['Center', 'Right-Leaning', 'Right'];
    else if (dominantLean.includes('Right')) targetLean = ['Center', 'Left-Leaning', 'Left'];

    let challengerArticles = await Article.find({
        politicalLean: { $in: targetLean },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    })
    .sort({ trustScore: -1 }) 
    .limit(10)
    .lean();

    // FALLBACK 3: No Challengers found
    if (challengerArticles.length === 0) {
        challengerArticles = await Article.find({ politicalLean: 'Center' })
            .sort({ publishedAt: -1 }).limit(10).lean();
    }

    // 4. Mark them
    const processed = challengerArticles.map(a => ({ ...a, suggestionType: 'Challenge' }));

    res.status(200).json({ 
        articles: processed, 
        meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
    });
}));

// --- 5. Personalized "My Mix" Feed ---
router.get('/articles/personalized', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // FALLBACK 1: Guest
    if (!req.user || !req.user.uid) {
        const trending = await Article.find({}).sort({ publishedAt: -1 }).limit(15).lean();
        return res.status(200).json({ articles: trending, meta: { topCategories: ['Trending'] } });
    }

    const userId = req.user.uid;
    
    // 1. Get recent activity
    const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' })
        .sort({ timestamp: -1 })
        .limit(50);
        
    // FALLBACK 2: No Activity
    if (recentLogs.length === 0) {
        const trending = await Article.find({}).sort({ publishedAt: -1 }).limit(15).lean();
        return res.status(200).json({ articles: trending, meta: { topCategories: ['Trending'] } });
    }
        
    const articleIds = recentLogs.map(l => l.articleId);
    const viewedArticles = await Article.find({ _id: { $in: articleIds } }).select('category politicalLean');
    
    const categoryCounts: Record<string, number> = {};
    viewedArticles.forEach(a => {
        categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1;
    });
    
    const topCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(x => x[0]);

    let recommendations: any[] = [];
    
    if (topCategories.length > 0) {
        recommendations = await Article.aggregate([
            { 
                $match: { 
                    category: { $in: topCategories },
                    publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } 
                } 
            },
            { $sample: { size: 15 } } 
        ]);
    }

    // FALLBACK 3: No matches
    if (recommendations.length === 0) {
        recommendations = await Article.find({})
            .sort({ publishedAt: -1 }).limit(15).lean();
    }

    const finalFeed = recommendations.map(a => ({ ...a, suggestionType: 'Comfort' }));

    res.status(200).json({ 
        articles: finalFeed, 
        meta: { topCategories } 
    });
}));

// --- 6. Saved Articles ---
router.get('/saved', authenticate, asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const profile = await Profile.findOne({ userId: req.user.uid }).select('savedArticles');
    
    if (!profile || !profile.savedArticles.length) {
        return res.status(200).json({ articles: [] });
    }

    const articles = await Article.find({ _id: { $in: profile.savedArticles } })
        .sort({ publishedAt: -1 })
        .lean();

    res.status(200).json({ articles });
}));

// --- 7. Toggle Save Article ---
router.post('/:id/save', authenticate, validate(schemas.saveArticle, 'params'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const userId = req.user.uid;

    const profile = await Profile.findOne({ userId });
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }

    const articleId = new mongoose.Types.ObjectId(id);
    const strId = id.toString();
    const currentSaved = profile.savedArticles.map(s => s.toString());
    
    let message = '';
    
    if (currentSaved.includes(strId)) {
        profile.savedArticles = profile.savedArticles.filter(s => s.toString() !== strId) as any;
        message = 'Article unsaved';
    } else {
        profile.savedArticles.push(articleId);
        message = 'Article saved';
    }

    await profile.save();
    res.status(200).json({ message, savedArticles: profile.savedArticles });
}));

export default router;
