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
                sampleScore: { $max: "$trustScore" } // Quality check
            } 
        },
        { $match: { count: { $gte: 3 } } }, // Must have at least 3 articles
        { $sort: { count: -1 } },
        { $limit: 10 }
    ];

    // FORCE FIX: Cast to 'any' here to bypass Mongoose strict typing error
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

    // A. Strict Text Search (Fast & Ranked)
    const strictResults = await Article.find(
        { $text: { $search: query } },
        { score: { $meta: "textScore" } }
    )
    .sort({ score: { $meta: "textScore" }, publishedAt: -1 }) // Relevance + Recency
    .limit(limit)
    .lean();

    // B. Fallback: Regex Search (If strict results are low)
    let finalResults = strictResults;
    
    if (strictResults.length < 5) {
        // "Fuzzy" match on headline OR summary
        // Escape regex special chars to prevent crashes
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(safeQuery, 'i');

        const fuzzyResults = await Article.find({
            $or: [
                { headline: { $regex: regex } },
                { clusterTopic: { $regex: regex } }
            ],
            // Exclude IDs we already found
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

    // Filters
    if (category && category !== 'All Categories') query.category = category;
    if (lean && lean !== 'All Leans') query.politicalLean = lean;
    
    if (region === 'India') query.country = 'India';
    else if (region === 'Global') query.country = { $ne: 'India' };

    if (articleType === 'Hard News') query.analysisType = 'Full';
    else if (articleType === 'Opinion & Reviews') query.analysisType = 'SentimentOnly';

    if (quality && quality !== 'All Quality Levels') {
        // Map UI labels to Grades
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

    // Sort Logic
    let sortOptions: any = { publishedAt: -1 }; // Default: Latest
    if (sort === 'Highest Quality') sortOptions = { trustScore: -1 };
    else if (sort === 'Most Covered') sortOptions = { clusterCount: -1 }; // Needs cluster aggregation to be accurate, but schema has placeholder
    else if (sort === 'Lowest Bias') sortOptions = { biasScore: 1 }; // Ascending

    // Execute
    const articles = await Article.find(query)
        .sort(sortOptions)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();

    const total = await Article.countDocuments(query);

    res.status(200).json({ articles, pagination: { total } });
}));

// --- 4. "For You" Feed (The "Balanced" Algorithm) ---
router.get('/articles/for-you', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user.uid;
    
    // 1. Get User's Bias History
    const history = await ActivityLog.find({ userId, action: 'view_analysis' })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();
    
    // If no history, return standard trending
    if (history.length === 0) {
        const standard = await Article.find({}).sort({ publishedAt: -1 }).limit(10).lean();
        return res.status(200).json({ articles: standard, meta: { reason: "No history" } });
    }

    // 2. Identify "Echo Chamber" risk
    const articleIds = history.map(h => h.articleId);
    const viewedDocs = await Article.find({ _id: { $in: articleIds } }).select('politicalLean category');
    
    const leanCounts: Record<string, number> = {};
    viewedDocs.forEach(d => { leanCounts[d.politicalLean] = (leanCounts[d.politicalLean] || 0) + 1; });
    
    // Find dominant lean
    let dominantLean = 'Center';
    let maxCount = 0;
    Object.entries(leanCounts).forEach(([lean, count]) => {
        if (count > maxCount) { maxCount = count; dominantLean = lean; }
    });

    // 3. Fetch "Challenger" Articles (Opposite views)
    let targetLean = ['Center'];
    if (dominantLean.includes('Left')) targetLean = ['Center', 'Right-Leaning', 'Right'];
    else if (dominantLean.includes('Right')) targetLean = ['Center', 'Left-Leaning', 'Left'];

    const challengerArticles = await Article.find({
        politicalLean: { $in: targetLean },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
    })
    .sort({ trustScore: -1 }) // Best quality challengers
    .limit(10)
    .lean();

    // 4. Mark them
    const processed = challengerArticles.map(a => ({ ...a, suggestionType: 'Challenge' }));

    res.status(200).json({ 
        articles: processed, 
        meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
    });
}));

// --- 5. Personalized "My Mix" Feed ---
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
        { $sample: { size: 15 } } // Randomize within preferences
    ]);

    const finalFeed = recommendations.map(a => ({ ...a, suggestionType: 'Comfort' }));

    res.status(200).json({ 
        articles: finalFeed, 
        meta: { topCategories } 
    });
}));

// --- 6. Saved Articles ---
router.get('/saved', asyncHandler(async (req: Request, res: Response) => {
    const profile = await Profile.findOne({ userId: req.user.uid }).select('savedArticles');
    
    if (!profile || !profile.savedArticles.length) {
        return res.status(200).json({ articles: [] });
    }

    // Fetch full article objects
    const articles = await Article.find({ _id: { $in: profile.savedArticles } })
        .sort({ publishedAt: -1 })
        .lean();

    res.status(200).json({ articles });
}));

// --- 7. Toggle Save Article (FIXED) ---
router.post('/:id/save', validate(schemas.saveArticle, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user.uid;

    const profile = await Profile.findOne({ userId });
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }

    const articleId = new mongoose.Types.ObjectId(id);
    
    // FIX: Use String comparison for reliable check
    const strId = id.toString();
    const currentSaved = profile.savedArticles.map(s => s.toString());
    
    let message = '';
    
    if (currentSaved.includes(strId)) {
        // Remove
        profile.savedArticles = profile.savedArticles.filter(s => s.toString() !== strId) as any;
        message = 'Article unsaved';
    } else {
        // Add
        profile.savedArticles.push(articleId);
        message = 'Article saved';
    }

    await profile.save();
    res.status(200).json({ message, savedArticles: profile.savedArticles });
}));

export default router;
