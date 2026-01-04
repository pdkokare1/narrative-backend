// services/articleService.ts
import mongoose from 'mongoose';
import Article, { ArticleDocument } from '../models/articleModel';
import Narrative from '../models/narrativeModel'; 
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';
import { CONSTANTS } from '../utils/constants';
import aiService from './aiService'; 
import { FeedFilters } from '../types';
import { buildArticleQuery, buildNarrativeQuery } from '../utils/feedUtils';

// Helper: Optimize Image URLs for bandwidth
const optimizeImageUrl = (url?: string) => {
    if (!url) return undefined;
    if (url.includes('cloudinary.com') && !url.includes('f_auto')) {
        return url.replace('/upload/', '/upload/f_auto,q_auto,w_800/');
    }
    return url;
};

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
                        analysisVersion: { $ne: 'pending' }
                    } 
                },
                { $group: { _id: "$clusterTopic", count: { $sum: 1 }, sampleScore: { $max: "$trustScore" } } },
                { $match: { count: { $gte: 3 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]).read('secondaryPreferred'); 

            return results.map(r => ({ topic: r._id, count: r.count, score: r.sampleScore }));
        }, 
        CONSTANTS.CACHE.TTL_TRENDING
    ); 
  }

  // --- 2. Intelligent Search ---
  async searchArticles(query: string, limit: number = 12) {
    if (!query) return { articles: [], total: 0 };
    
    const safeQuery = query.replace(/[^\w\s\-\.\?]/gi, '');
    const CACHE_KEY = `search:v3:${safeQuery.toLowerCase().trim()}:${limit}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        let articles: any[] = [];
        let searchMethod = 'Text';

        try {
            const queryEmbedding = await aiService.createEmbedding(safeQuery);
            
            if (queryEmbedding && queryEmbedding.length > 0) {
                const pipeline: any[] = [
                    {
                        "$vectorSearch": {
                            "index": "vector_index",
                            "path": "embedding",
                            "queryVector": queryEmbedding,
                            "numCandidates": 100, 
                            "limit": limit * 2 
                        }
                    },
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

        if (!articles.length) {
            const rawArticles = await Article.smartSearch(safeQuery, limit * 2);
            articles = rawArticles.filter((a: any) => a.analysisVersion !== 'pending').slice(0, limit);
        }

        articles = articles.map(a => ({ ...a, imageUrl: optimizeImageUrl(a.imageUrl) }));
        logger.info(`🔍 Search: "${safeQuery}" | Method: ${searchMethod} | Results: ${articles.length}`);
        return { articles, total: articles.length };
    }, CONSTANTS.CACHE.TTL_SEARCH);
  }

  // --- 3. Main Feed (Refactored) ---
  async getMainFeed(filters: FeedFilters) {
    const { sort, limit = 20, offset = 0 } = filters;
    
    // A. Build Queries (Using Utils)
    const query = buildArticleQuery(filters);
    
    // CRITICAL: Filter out pending analysis to prevent incomplete data
    (query as any).analysisVersion = { $ne: 'pending' };

    const narrativeQuery = buildNarrativeQuery(filters);

    // B. Fetch Narratives
    const narratives = await Narrative.find(narrativeQuery)
                                      .select('-articles -vector') 
                                      .sort({ lastUpdated: -1 })
                                      .limit(5)
                                      .lean()
                                      .read('secondaryPreferred'); 

    // C. Smart Dedup (Filter out articles belonging to fetched narratives)
    const narrativeClusterIds = narratives.map(n => n.clusterId);
    if (narrativeClusterIds.length > 0) {
        (query as any).clusterId = { $nin: narrativeClusterIds };
    }

    // D. Sort Options
    let sortOptions: any = { publishedAt: -1 };
    if (sort === 'Highest Quality') sortOptions = { trustScore: -1 };
    else if (sort === 'Most Covered') sortOptions = { clusterCount: -1 };
    else if (sort === 'Lowest Bias') sortOptions = { biasScore: 1 };

    // E. Fetch Articles
    const articles = await Article.find(query)
        .select('-content -embedding -keyFindings -recommendations')
        .sort(sortOptions)
        .skip(Number(offset))
        .limit(Number(limit))
        .lean()
        .read('secondaryPreferred'); 

    // F. Combine
    const feedItems = [
        ...narratives.map(n => ({ ...n, type: 'Narrative', publishedAt: n.lastUpdated })),
        ...articles.map(a => ({ 
            ...a, 
            type: 'Article',
            imageUrl: optimizeImageUrl(a.imageUrl)
        }))
    ];

    feedItems.sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    const totalArticles = await Article.countDocuments(query).read('secondaryPreferred');
    
    // FIX: Removed blocking cache here. We rely on Controller cache or direct fetch.
    return { 
        articles: feedItems.slice(0, Number(limit)), 
        pagination: { total: totalArticles + narratives.length } 
    };
  }

  // --- 4. For You Feed ---
  async getForYouFeed(userId: string | undefined) {
    if (!userId) {
        const standard = await Article.find({ analysisVersion: { $ne: 'pending' } })
            .select('-content -embedding')
            .sort({ trustScore: -1, publishedAt: -1 })
            .limit(10)
            .lean()
            .read('secondaryPreferred');
        return { articles: standard, meta: { reason: "Guest User" } };
    }

    const CACHE_KEY = `feed_foryou_v2:${userId}`;

    return redis.getOrFetch(CACHE_KEY, async () => {
        const history = await ActivityLog.find({ userId, action: 'view_analysis' })
            .sort({ timestamp: -1 })
            .limit(20)
            .lean();
        
        if (history.length === 0) {
            const standard = await Article.find({ analysisVersion: { $ne: 'pending' } })
                .select('-content -embedding')
                .sort({ trustScore: -1, publishedAt: -1 })
                .limit(10)
                .lean()
                .read('secondaryPreferred');
            return { articles: standard, meta: { reason: "No history" } };
        }

        const articleIds = history.map(h => h.articleId);
        const viewedDocs = await Article.find({ _id: { $in: articleIds } }).select('politicalLean').lean();
        const leanCounts: Record<string, number> = {};
        viewedDocs.forEach((d: any) => { leanCounts[d.politicalLean] = (leanCounts[d.politicalLean] || 0) + 1; });
        
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
            analysisVersion: { $ne: 'pending' }
        })
        .select('-content -embedding')
        .sort({ trustScore: -1, publishedAt: -1 })
        .limit(10)
        .lean()
        .read('secondaryPreferred');

        if (challengerArticles.length === 0) {
            challengerArticles = await Article.find({ 
                politicalLean: 'Center',
                analysisVersion: { $ne: 'pending' }
            })
            .select('-content -embedding')
            .sort({ publishedAt: -1 })
            .limit(10)
            .lean()
            .read('secondaryPreferred');
        }

        return { 
            articles: challengerArticles.map(a => ({ 
                ...a, 
                suggestionType: 'Challenge',
                imageUrl: optimizeImageUrl(a.imageUrl)
            })), 
            meta: { basedOnCategory: 'Your Reading History', usualLean: dominantLean } 
        };
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 5. Personalized "My Mix" Feed ---
  async getPersonalizedFeed(userId: string) {
    const CACHE_KEY = `my_mix_v2:${userId}`;
    
    return redis.getOrFetch(CACHE_KEY, async () => {
        const profile = await Profile.findOne({ userId }).select('userEmbedding').lean();
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
                            "analysisVersion": { "$ne": "pending" }
                        } 
                    },
                    { "$limit": 20 },
                    { 
                        "$project": { 
                            "headline": 1, "summary": 1, "source": 1, "category": 1, "politicalLean": 1, 
                            "url": 1, "imageUrl": 1, "publishedAt": 1, "analysisType": 1, 
                            "sentiment": 1, "biasScore": 1, "trustScore": 1, "clusterTopic": 1, 
                            "audioUrl": 1, "score": { "$meta": "vectorSearchScore" } 
                        } 
                    }
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
                const viewedArticles = await Article.find({ _id: { $in: articleIds } }).select('category').lean();
                const categoryCounts: Record<string, number> = {};
                viewedArticles.forEach((a: any) => categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1);
                
                const topCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
                metaReason = `Based on ${topCategories.join(', ')}`;
                
                if (topCategories.length > 0) {
                    recommendations = await Article.aggregate([
                        { 
                            $match: { 
                                category: { $in: topCategories }, 
                                publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
                                analysisVersion: { $ne: 'pending' }
                            } 
                        },
                        { $sample: { size: 15 } },
                        { $project: { embedding: 0, content: 0 } }
                    ]);
                }
            }
        }

        if (recommendations.length === 0) {
            recommendations = await Article.find({ analysisVersion: { $ne: 'pending' } })
                .select('-content -embedding')
                .sort({ publishedAt: -1 })
                .limit(15)
                .lean()
                .read('secondaryPreferred');
            metaReason = "Trending (No Data)";
        }

        return { 
            articles: recommendations.map(a => ({ 
                ...a, 
                suggestionType: 'Comfort',
                imageUrl: optimizeImageUrl(a.imageUrl)
            })), 
            meta: { topCategories: [metaReason] } 
        };
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 6. Saved Articles ---
  async getSavedArticles(userId: string) {
    const profile = await Profile.findOne({ userId }).select('savedArticles').lean();
    if (!profile || !profile.savedArticles.length) return [];
    
    const articles = await Article.find({ _id: { $in: profile.savedArticles } })
        .select('-content -embedding')
        .sort({ publishedAt: -1 })
        .lean()
        .read('secondaryPreferred'); 
        
    return articles.map(a => ({ ...a, imageUrl: optimizeImageUrl(a.imageUrl) }));
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
