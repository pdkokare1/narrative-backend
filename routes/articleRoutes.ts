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

// --- AUTH MIDDLEWARE ---
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

// --- 1. Smart Trending Topics (Optimized) ---
router.get('/trending', asyncHandler(async (req: Request, res: Response) => {
    const CACHE_KEY = 'trending_topics_smart';
    
    // 1. Try Cache (Fast Path)
    const cachedData = await redis.get(CACHE_KEY);
    if (cachedData) {
        // Browser/CDN Cache: Valid for 30 minutes (1800s)
        res.set('Cache-Control', 'public, max-age=1800'); 
        return res.status(200).json({ topics: cachedData });
    }

    // 2. Fallback: Calculate on demand (Slow Path)
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const results = await Article.aggregate([
        { $match: { publishedAt: { $gte: twoDaysAgo }, clusterTopic: { $exists: true, $ne: null } } },
        { $group: { _id: "$clusterTopic", count: { $sum: 1 }, sampleScore: { $max: "$trustScore" } } },
        { $match: { count: { $gte: 3 } } }, 
        { $sort: { count: -1 } },
        { $limit: 10 }
    ]);
    
    const topics = results.map(r => ({ topic: r._id, count: r.count, score: r.sampleScore }));
    
    await redis.set(CACHE_KEY, topics, 1800);
    
    res.status(200).json({ topics });
}));

// --- 2. Intelligent Search (MongoDB Atlas Search) ---
router.get('/search', validate(schemas.search, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.q as string).trim();
    const limit = parseInt(req.query.limit as string) || 12;
    
    if (!query) return res.status(200).json({ articles: [], pagination: { total: 0 } });

    const pipeline = [
        {
            $search: {
                index: 'default', // Ensure 'default' index exists in Atlas
                compound: {
                    should: [
                        {
                            text: {
                                query: query,
                                path: 'headline',
                                fuzzy: { maxEdits: 2 },
                                score: { boost: { value: 3 } }
                            }
                        },
                        {
                            text: {
                                query: query,
                                path: ['summary', 'clusterTopic'],
                                fuzzy: { maxEdits: 1 }
                            }
                        }
                    ]
                }
            }
        },
        { $limit: limit },
        {
            $project: {
                headline: 1, summary: 1, source: 1, category: 1, 
                politicalLean: 1, url: 1, imageUrl: 1, publishedAt: 1,
                analysisType: 1, sentiment: 1, biasScore: 1, trustScore: 1,
                score: { $meta: "searchScore" }
            }
        }
    ];

    try {
        const results = await Article.aggregate(pipeline);
        res.status(200).json({ articles: results, pagination: { total: results.length } });
    } catch (error) {
        console.warn("Atlas Search failed, falling back to Regex:", error);
        const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const fallback = await Article.find({ headline: { $regex: regex } }).limit(limit).lean();
        res.status(200).json({ articles: fallback, pagination: { total: fallback.length } });
    }
}));

// --- 3. Main Feed ---
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

    // Performance: .lean() is faster for read-only data
    const articles = await Article.find(query)
        .sort(sortOptions)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();

    const total = await Article.countDocuments(query);
    
    // Cache public feeds for 5 minutes
    res.set('Cache-Control', 'public, max-age=300');
    
    res.status(200).json({ articles, pagination: { total } });
}));

// --- 4. "For You" Feed ---
router.get('/articles/for-you', authenticate, asyncHandler(async (req: Request, res: Response) => {
    if (!req.user || !req.user.uid) {
        const standard = await Article.find({}).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return res.status(200).json({ articles: standard, meta: { reason: "Guest User" } });
    }

    const userId = req.user.uid;
    const history = await ActivityLog.find({ userId, action: 'view_analysis' }).sort({ timestamp: -1 }).limit(20).lean();
    
    if (history.length === 0) {
        const standard = await Article.find({}).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return res.status(200).json({ articles: standard, meta: { reason: "No history" } });
    }

    const articleIds = history.map(h => h.articleId);
    const viewedDocs = await Article.find({ _id: { $in: articleIds } }).select('politicalLean');
    const leanCounts: Record<string, number> = {};
    viewedDocs.forEach(d => { leanCounts[d.politicalLean] = (leanCounts[d.politicalLean] || 0) + 1; });
    
    let dominantLean = 'Center';
    let maxCount = 0;
    Object.entries(leanCounts).forEach(([lean, count]) => { if (count > maxCount) { maxCount = count; dominantLean = lean; } });

    let targetLean = ['Center'];
    if (dominantLean.includes('Left')) targetLean = ['Center', 'Right-Leaning', 'Right'];
    else if (dominantLean.includes('Right')) targetLean = ['Center', 'Left-Leaning', 'Left'];

    let challengerArticles = await Article.find({
        politicalLean: { $in: targetLean },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
    }).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();

    if (challengerArticles.length === 0) {
        challengerArticles = await Article.find({ politicalLean: 'Center' }).sort({ publishedAt: -1 }).limit(10).lean();
    }

    res.status(200).json({ 
        articles: challengerArticles.map(a => ({ ...a, suggestionType: 'Challenge' })), 
        meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
    });
}));

// --- 5. Personalized "My Mix" Feed (VECTOR ENHANCED & OPTIMIZED) ---
router.get('/articles/personalized', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // A. Guest Fallback
    if (!req.user || !req.user.uid) {
        const trending = await Article.find({}).sort({ publishedAt: -1 }).limit(15).lean();
        return res.status(200).json({ articles: trending, meta: { topCategories: ['Trending'] } });
    }

    const userId = req.user.uid;
    
    // B. Fetch Profile for Vector
    const profile = await Profile.findOne({ userId }).select('userEmbedding');
    const hasVector = profile && profile.userEmbedding && profile.userEmbedding.length > 0;

    let recommendations: any[] = [];
    let metaReason = "Trending";

    // --- STRATEGY 1: VECTOR SEARCH (AI Powered) ---
    if (hasVector) {
        try {
            // OPTIMIZATION: Date filter moved to Aggregation Pipeline ($match)
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

            const pipeline: any = [
                {
                    "$vectorSearch": {
                        "index": "vector_index", 
                        "path": "embedding",
                        "queryVector": profile.userEmbedding,
                        "numCandidates": 150, 
                        "limit": 50 // Fetch more to allow for filtering
                    }
                },
                {
                    // DATABASE SIDE FILTERING (Faster than JS filtering)
                    "$match": {
                        "publishedAt": { "$gte": threeDaysAgo }
                    }
                },
                { "$limit": 20 }, // Trim to final size
                {
                    "$project": {
                        "headline": 1, "summary": 1, "source": 1, "category": 1,
                        "politicalLean": 1, "url": 1, "imageUrl": 1, "publishedAt": 1,
                        "analysisType": 1, "sentiment": 1, "biasScore": 1, "trustScore": 1,
                        "clusterTopic": 1, "audioUrl": 1,
                        "score": { "$meta": "vectorSearchScore" } 
                    }
                }
            ];

            recommendations = await Article.aggregate(pipeline);
            metaReason = "AI Curated (Interest Match)";

        } catch (error) {
            console.error("Vector Search Failed (Falling back to legacy):", error);
        }
    }

    // --- STRATEGY 2: LEGACY CATEGORY MATCH (Fallback) ---
    if (recommendations.length === 0) {
        const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' }).sort({ timestamp: -1 }).limit(50).lean();
        
        if (recentLogs.length > 0) {
            const articleIds = recentLogs.map(l => l.articleId);
            const viewedArticles = await Article.find({ _id: { $in: articleIds } }).select('category');
            const categoryCounts: Record<string, number> = {};
            viewedArticles.forEach(a => categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1);
            
            const topCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
            metaReason = `Based on ${topCategories.join(', ')}`;

            if (topCategories.length > 0) {
                recommendations = await Article.aggregate([
                    { $match: { category: { $in: topCategories }, publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } } },
                    { $sample: { size: 15 } } 
                ]);
            }
        }
    }

    // --- STRATEGY 3: GENERIC TRENDING (Final Fallback) ---
    if (recommendations.length === 0) {
        recommendations = await Article.find({}).sort({ publishedAt: -1 }).limit(15).lean();
        metaReason = "Trending (No Data)";
    }

    res.status(200).json({ 
        articles: recommendations.map(a => ({ ...a, suggestionType: 'Comfort' })), 
        meta: { topCategories: [metaReason] } 
    });
}));

// --- 6. Saved Articles ---
router.get('/saved', authenticate, asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const profile = await Profile.findOne({ userId: req.user.uid }).select('savedArticles');
    if (!profile || !profile.savedArticles.length) return res.status(200).json({ articles: [] });
    const articles = await Article.find({ _id: { $in: profile.savedArticles } }).sort({ publishedAt: -1 }).lean();
    res.status(200).json({ articles });
}));

// --- 7. Toggle Save ---
router.post('/:id/save', authenticate, validate(schemas.saveArticle, 'params'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const userId = req.user.uid;
    const profile = await Profile.findOne({ userId });
    if (!profile) throw new Error('Profile not found');

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
