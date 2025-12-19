// services/articleService.ts
import mongoose from 'mongoose';
import Article, { ArticleDocument } from '../models/articleModel';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';
import { CONSTANTS } from '../utils/constants';

// Interface for Filter Arguments
interface FeedFilters {
    category?: string;
    lean?: string;
    region?: string;
    articleType?: string;
    quality?: string;
    sort?: string;
    limit?: number | string;
    offset?: number | string;
}

class ArticleService {
  
  // --- 1. Smart Trending Topics ---
  async getTrendingTopics() {
    return redis.getOrFetch(
        CONSTANTS.REDIS_KEYS.TRENDING, 
        async () => {
            const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const results = await Article.aggregate([
                { $match: { publishedAt: { $gte: twoDaysAgo }, clusterTopic: { $exists: true, $ne: null } } },
                { $group: { _id: "$clusterTopic", count: { $sum: 1 }, sampleScore: { $max: "$trustScore" } } },
                { $match: { count: { $gte: 3 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]);

            return results.map(r => ({ topic: r._id, count: r.count, score: r.sampleScore }));
        }, 
        CONSTANTS.CACHE.TTL_TRENDING
    ); 
  }

  // --- 2. Intelligent Search (Centralized) ---
  async searchArticles(query: string, limit: number = 12) {
    if (!query) return { articles: [], total: 0 };
    
    const safeQuery = query.replace(/[^\w\s\-\.\?]/gi, '');
    const CACHE_KEY = `search:${safeQuery.toLowerCase().trim()}:${limit}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        // Updated: Delegates logic to Model (DRY Principle)
        const articles = await Article.smartSearch(safeQuery, limit);
        return { articles, total: articles.length };
    }, CONSTANTS.CACHE.TTL_SEARCH);
  }

  // --- 3. Main Feed (Cached) ---
  async getMainFeed(filters: FeedFilters) {
    const { category, lean, region, articleType, quality, sort, limit = 20, offset = 0 } = filters;
    
    // Unique key based on all filters
    const CACHE_KEY = `feed:${category || 'all'}:${lean || 'all'}:${region || 'all'}:${sort || 'latest'}:${offset}:${limit}`;
    
    return redis.getOrFetch(CACHE_KEY, async () => {
        // Build Query
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
            const grades = gradeMap[quality];
            if (grades) query.credibilityGrade = { $in: grades };
        }

        let sortOptions: any = { publishedAt: -1 };
        if (sort === 'Highest Quality') sortOptions = { trustScore: -1 };
        else if (sort === 'Most Covered') sortOptions = { clusterCount: -1 };
        else if (sort === 'Lowest Bias') sortOptions = { biasScore: 1 };

        // Database Fetch
        const articles = await Article.find(query)
            .sort(sortOptions)
            .skip(Number(offset))
            .limit(Number(limit))
            .lean();

        const total = await Article.countDocuments(query);
        return { articles, pagination: { total } };
    }, CONSTANTS.CACHE.TTL_FEED);
  }

  // --- 4. For You Feed (Cached) ---
  async getForYouFeed(userId: string | undefined) {
    // Guest User - No cache needed (lightweight)
    if (!userId) {
        const standard = await Article.find({}).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return { articles: standard, meta: { reason: "Guest User" } };
    }

    const CACHE_KEY = `feed_foryou:${userId}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        const history = await ActivityLog.find({ userId, action: 'view_analysis' })
            .sort({ timestamp: -1 })
            .limit(20)
            .lean();
        
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
        Object.entries(leanCounts).forEach(([lean, count]) => { 
            if (count > maxCount) { maxCount = count; dominantLean = lean; } 
        });

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
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 5. Personalized Feed (Cached) ---
  async getPersonalizedFeed(userId: string) {
    const CACHE_KEY = `my_mix_${userId}`;
    
    return redis.getOrFetch(CACHE_KEY, async () => {
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
            // Fallback: Category matching
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

        return { 
            articles: recommendations.map(a => ({ ...a, suggestionType: 'Comfort' })), 
            meta: { topCategories: [metaReason] } 
        };
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 6. Saved Articles ---
  async getSavedArticles(userId: string) {
    const profile = await Profile.findOne({ userId }).select('savedArticles');
    if (!profile || !profile.savedArticles.length) return [];
    return Article.find({ _id: { $in: profile.savedArticles } }).sort({ publishedAt: -1 }).lean();
  }

  // --- 7. Toggle Save (ATOMIC) ---
  async toggleSaveArticle(userId: string, articleIdStr: string) {
    const articleId = new mongoose.Types.ObjectId(articleIdStr);
    
    // 1. Check current state (Read)
    const profile = await Profile.findOne({ userId, savedArticles: articleId });
    
    let updateOp;
    let message;
    
    if (profile) {
        // If exists, remove it atomically
        updateOp = { $pull: { savedArticles: articleId } };
        message = 'Article unsaved';
    } else {
        // If not exists, add it atomically (avoids duplicates)
        updateOp = { $addToSet: { savedArticles: articleId } };
        message = 'Article saved';
    }
    
    // 2. Perform Atomic Update
    const updatedProfile = await Profile.findOneAndUpdate(
        { userId },
        updateOp as any,
        { new: true }
    ).select('savedArticles');
    
    if (!updatedProfile) throw new Error('Profile not found');

    return { message, savedArticles: updatedProfile.savedArticles };
  }
}

export default new ArticleService();
