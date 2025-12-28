// narrative-backend/services/articleService.ts
import mongoose from 'mongoose';
import Article, { ArticleDocument } from '../models/articleModel';
import Narrative from '../models/narrativeModel'; 
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';
import { CONSTANTS } from '../utils/constants';
import aiService from './aiService'; 

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
                { 
                    $match: { 
                        publishedAt: { $gte: twoDaysAgo }, 
                        clusterTopic: { $exists: true, $ne: null },
                        // FILTER: Exclude pending articles
                        analysisVersion: { $ne: 'pending' }
                    } 
                },
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

  // --- 2. Intelligent Search ---
  async searchArticles(query: string, limit: number = 12) {
    if (!query) return { articles: [], total: 0 };
    
    const safeQuery = query.replace(/[^\w\s\-\.\?]/gi, '');
    const CACHE_KEY = `search:v2:${safeQuery.toLowerCase().trim()}:${limit}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        let articles: any[] = [];
        let searchMethod = 'Text';

        try {
            // A. Try Semantic Search First (AI Powered)
            const queryEmbedding = await aiService.createEmbedding(safeQuery);
            
            if (queryEmbedding && queryEmbedding.length > 0) {
                const pipeline: any[] = [
                    {
                        "$vectorSearch": {
                            "index": "vector_index",
                            "path": "embedding",
                            "queryVector": queryEmbedding,
                            "numCandidates": 100, 
                            "limit": limit * 2 // Fetch extra to allow for filtering
                        }
                    },
                    // FILTER: Exclude pending articles
                    { "$match": { analysisVersion: { $ne: 'pending' } } },
                    { "$limit": limit },
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
                
                articles = await Article.aggregate(pipeline);
                searchMethod = 'Vector';
            }
        } catch (err) {
            logger.warn(`Semantic Search Failed (Fallback to Text): ${err}`);
        }

        // B. Fallback to Text Search
        if (!articles.length) {
            // Note: smartSearch is a model static, so we filter AFTER fetching
            // since we can't easily modify the model static right now.
            const rawArticles = await Article.smartSearch(safeQuery, limit * 2);
            articles = rawArticles.filter((a: any) => a.analysisVersion !== 'pending').slice(0, limit);
        }

        logger.info(`🔍 Search: "${safeQuery}" | Method: ${searchMethod} | Results: ${articles.length}`);
        
        return { articles, total: articles.length };
    }, CONSTANTS.CACHE.TTL_SEARCH);
  }

  // --- 3. Main Feed (Optimized & Centralized Caching) ---
  async getMainFeed(filters: FeedFilters) {
    const { category, lean, region, articleType, quality, sort, limit = 20, offset = 0 } = filters;
    
    // Encapsulate the expensive fetching logic
    const fetchFeedData = async () => {
        // A. Build Query
        const query: any = {
            // FILTER: Exclude pending articles globally
            analysisVersion: { $ne: 'pending' }
        };
        
        if (category && category !== 'All Categories' && category !== 'All' && category !== 'undefined') {
            query.category = category;
        }
        if (lean && lean !== 'All Leans' && lean !== 'undefined') query.politicalLean = lean;
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

        // B. Fetch Narratives
        const narrativeQuery: any = {};
        if (category && category !== 'All Categories' && category !== 'All' && category !== 'undefined') {
            narrativeQuery.category = category;
        }
        if (region === 'India') narrativeQuery.country = 'India';
        narrativeQuery.lastUpdated = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };

        const narratives = await Narrative.find(narrativeQuery)
                                          .sort({ lastUpdated: -1 })
                                          .limit(5)
                                          .lean();

        // C. Smart Dedup
        const narrativeClusterIds = narratives.map(n => n.clusterId);
        if (narrativeClusterIds.length > 0) {
            query.clusterId = { $nin: narrativeClusterIds };
        }

        // D. Sort Options
        let sortOptions: any = { publishedAt: -1 };
        if (sort === 'Highest Quality') sortOptions = { trustScore: -1 };
        else if (sort === 'Most Covered') sortOptions = { clusterCount: -1 };
        else if (sort === 'Lowest Bias') sortOptions = { biasScore: 1 };

        // E. Fetch Articles
        const articles = await Article.find(query)
            .sort(sortOptions)
            .skip(Number(offset))
            .limit(Number(limit))
            .lean();

        // F. Combine
        const feedItems = [
            ...narratives.map(n => ({ ...n, type: 'Narrative', publishedAt: n.lastUpdated })),
            ...articles.map(a => ({ ...a, type: 'Article' }))
        ];

        feedItems.sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

        const totalArticles = await Article.countDocuments(query);
        
        return { 
            articles: feedItems.slice(0, Number(limit)), 
            pagination: { total: totalArticles + narratives.length } 
        };
    };

    // Use getOrFetch ONLY for the first page to ensure freshness for deep pagination
    // and speed for the initial load.
    if (Number(offset) === 0) {
        const CACHE_KEY = `feed_v2:${category || 'all'}:${lean || 'all'}:${region || 'all'}:${sort || 'latest'}:${limit}`;
        return redis.getOrFetch(CACHE_KEY, fetchFeedData, CONSTANTS.CACHE.TTL_FEED);
    } else {
        return fetchFeedData();
    }
  }

  // --- 4. For You Feed ---
  async getForYouFeed(userId: string | undefined) {
    if (!userId) {
        const standard = await Article.find({ analysisVersion: { $ne: 'pending' } })
            .sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
        return { articles: standard, meta: { reason: "Guest User" } };
    }

    const CACHE_KEY = `feed_foryou:${userId}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        const history = await ActivityLog.find({ userId, action: 'view_analysis' })
            .sort({ timestamp: -1 })
            .limit(20)
            .lean();
        
        if (history.length === 0) {
            const standard = await Article.find({ analysisVersion: { $ne: 'pending' } })
                .sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();
            return { articles: standard, meta: { reason: "No history" } };
        }

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
            publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            // FILTER: Exclude pending
            analysisVersion: { $ne: 'pending' }
        }).sort({ trustScore: -1, publishedAt: -1 }).limit(10).lean();

        if (challengerArticles.length === 0) {
            challengerArticles = await Article.find({ 
                politicalLean: 'Center',
                analysisVersion: { $ne: 'pending' }
            }).sort({ publishedAt: -1 }).limit(10).lean();
        }

        return { 
            articles: challengerArticles.map(a => ({ ...a, suggestionType: 'Challenge' })), 
            meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
        };
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 5. Personalized Feed ---
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
                    { 
                        "$match": { 
                            "publishedAt": { "$gte": threeDaysAgo },
                            // FILTER: Exclude pending
                            "analysisVersion": { "$ne": "pending" }
                        } 
                    },
                    { "$limit": 20 },
                    { "$project": { "headline": 1, "summary": 1, "source": 1, "category": 1, "politicalLean": 1, "url": 1, "imageUrl": 1, "publishedAt": 1, "analysisType": 1, "sentiment": 1, "biasScore": 1, "trustScore": 1, "clusterTopic": 1, "audioUrl": 1, "score": { "$meta": "vectorSearchScore" } } }
                ];
                recommendations = await Article.aggregate(pipeline);
                metaReason = "AI Curated (Interest Match)";
            } catch (error) {
                logger.error(`Vector Search Failed: ${error}`);
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
                        { 
                            $match: { 
                                category: { $in: topCategories }, 
                                publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
                                // FILTER: Exclude pending
                                analysisVersion: { $ne: 'pending' }
                            } 
                        },
                        { $sample: { size: 15 } }
                    ]);
                }
            }
        }

        if (recommendations.length === 0) {
            recommendations = await Article.find({ analysisVersion: { $ne: 'pending' } })
                .sort({ publishedAt: -1 }).limit(15).lean();
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

  // --- 7. Toggle Save ---
  async toggleSaveArticle(userId: string, articleIdStr: string) {
    const articleId = new mongoose.Types.ObjectId(articleIdStr);
    const profile = await Profile.findOne({ userId, savedArticles: articleId });
    
    let updateOp, message;
    if (profile) {
        updateOp = { $pull: { savedArticles: articleId } };
        message = 'Article unsaved';
    } else {
        updateOp = { $addToSet: { savedArticles: articleId } };
        message = 'Article saved';
    }
    
    const updatedProfile = await Profile.findOneAndUpdate({ userId }, updateOp as any, { new: true }).select('savedArticles');
    if (!updatedProfile) throw new Error('Profile not found');

    return { message, savedArticles: updatedProfile.savedArticles };
  }
}

export default new ArticleService();
