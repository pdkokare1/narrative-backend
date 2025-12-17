// services/articleService.ts
import mongoose from 'mongoose';
import Article, { ArticleDocument } from '../models/articleModel';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';

class ArticleService {
  
  // --- 1. Smart Trending Topics ---
  async getTrendingTopics() {
    const CACHE_KEY = 'trending_topics_smart';

    // 1. Try Cache
    const cachedData = await redis.get(CACHE_KEY);
    if (cachedData) return cachedData;

    // 2. Fallback: Calculate from DB
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const results = await Article.aggregate([
        { $match: { publishedAt: { $gte: twoDaysAgo }, clusterTopic: { $exists: true, $ne: null } } },
        { $group: { _id: "$clusterTopic", count: { $sum: 1 }, sampleScore: { $max: "$trustScore" } } },
        { $match: { count: { $gte: 3 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
    ]);

    const topics = results.map(r => ({ topic: r._id, count: r.count, score: r.sampleScore }));

    // Save to Redis for 30 minutes
    await redis.set(CACHE_KEY, topics, 1800);
    return topics;
  }

  // --- 2. Intelligent Search (Optimized) ---
  async searchArticles(query: string, limit: number = 12) {
    if (!query) return { articles: [], total: 0 };

    const safeQuery = query.replace(/[^\w\s\-\.\?]/gi, '');
    
    // Attempt 1: Atlas Search (If configured on MongoDB Cloud)
    const atlasPipeline: any[] = [
        {
            $search: {
                index: 'default',
                compound: {
                    should: [
                        { text: { query: safeQuery, path: 'headline', fuzzy: { maxEdits: 2 }, score: { boost: { value: 3 } } } },
                        { text: { query: safeQuery, path: ['summary', 'clusterTopic'], fuzzy: { maxEdits: 1 } } }
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
        const results = await Article.aggregate(atlasPipeline);
        if (results.length > 0) {
            return { articles: results, total: results.length };
        }
        throw new Error("No Atlas results");
    } catch (error) {
        // Attempt 2: Standard Text Index (Performance Fallback)
        // We use $text which uses the index, instead of $regex which scans the whole DB.
        logger.info("Falling back to Standard Text Search");
        const fallback = await Article.find(
            { $text: { $search: safeQuery } },
            { score: { $meta: 'textScore' } }
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .lean();

        return { articles: fallback, total: fallback.length };
    }
  }

  // --- 3. Main Feed (Cached) ---
  async getMainFeed(filters: any) {
    const { category, lean, region, articleType, quality, sort, limit, offset } = filters;
    
    const CACHE_KEY = `feed:${category || 'all'}:${lean || 'all'}:${region || 'all'}:${sort || 'latest'}:${offset || 0}:${limit || 20}`;
    
    // 1. Check Redis
    const cachedFeed = await redis.get(CACHE_KEY);
    if (cachedFeed) return cachedFeed;

    // 2. Build Query
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

    // 3. Database Fetch
    const articles = await Article.find(query)
        .sort(sortOptions)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean();

    const total = await Article.countDocuments(query);
    const result = { articles, pagination: { total } };

    // 4. Save to Redis (5 Minutes)
    await redis.set(CACHE_KEY, result, 300);
    return result;
  }

  // --- 4. For You Feed ---
  async getForYouFeed(userId: string | undefined) {
    // Guest User
    if (!userId) {
        const standard = await Article.find({}).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return { articles: standard, meta: { reason: "Guest User" } };
    }

    const history = await ActivityLog.find({ userId, action: 'view_analysis' }).sort({ timestamp: -1 }).limit(20).lean();
    
    if (history.length === 0) {
        const standard = await Article.find({}).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return { articles: standard, meta: { reason: "No history" } };
    }

    // Challenger Logic
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

    return { 
        articles: challengerArticles.map(a => ({ ...a, suggestionType: 'Challenge' })), 
        meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
    };
  }

  // --- 5. Personalized Feed ---
  async getPersonalizedFeed(userId: string) {
    const CACHE_KEY = `my_mix_${userId}`;
    const cachedMix = await redis.get(CACHE_KEY);
    if (cachedMix) return cachedMix;

    const profile = await Profile.findOne({ userId }).select('userEmbedding');
    const hasVector = profile && profile.userEmbedding && profile.userEmbedding.length > 0;

    let recommendations: any[] = [];
    let metaReason = "Trending";

    if (hasVector) {
        try {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            const pipeline: any = [
                {
                    "$vectorSearch": {
                        "index": "vector_index",
                        "path": "embedding",
                        "queryVector": profile.userEmbedding,
                        "numCandidates": 150,
                        "limit": 50
                    }
                },
                { "$match": { "publishedAt": { "$gte": threeDaysAgo } } },
                { "$limit": 20 },
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
            logger.error(`Vector Search Failed (ArticleService): ${error}`);
        }
    }

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

    if (recommendations.length === 0) {
        recommendations = await Article.find({}).sort({ publishedAt: -1 }).limit(15).lean();
        metaReason = "Trending (No Data)";
    }

    const responsePayload = { 
        articles: recommendations.map(a => ({ ...a, suggestionType: 'Comfort' })), 
        meta: { topCategories: [metaReason] } 
    };

    await redis.set(CACHE_KEY, responsePayload, 900);
    return responsePayload;
  }

  // --- 6. Saved Articles ---
  async getSavedArticles(userId: string) {
    const profile = await Profile.findOne({ userId }).select('savedArticles');
    if (!profile || !profile.savedArticles.length) return [];
    return Article.find({ _id: { $in: profile.savedArticles } }).sort({ publishedAt: -1 }).lean();
  }

  // --- 7. Toggle Save ---
  async toggleSaveArticle(userId: string, articleIdStr: string) {
    const profile = await Profile.findOne({ userId });
    if (!profile) throw new Error('Profile not found');

    const articleId = new mongoose.Types.ObjectId(articleIdStr);
    const currentSaved = profile.savedArticles.map(s => s.toString());
    
    let message = '';
    if (currentSaved.includes(articleIdStr)) {
        profile.savedArticles = profile.savedArticles.filter(s => s.toString() !== articleIdStr) as any;
        message = 'Article unsaved';
    } else {
        profile.savedArticles.push(articleId);
        message = 'Article saved';
    }
    await profile.save();
    return { message, savedArticles: profile.savedArticles };
  }
}

export default new ArticleService();
