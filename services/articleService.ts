// services/articleService.ts
import mongoose from 'mongoose';
import Article, { ArticleDocument } from '../models/articleModel';
import Narrative from '../models/narrativeModel'; 
import UserStats from '../models/userStatsModel'; 
import Profile from '../models/profileModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';
import { CONSTANTS } from '../utils/constants';
import aiService from './aiService'; 
import { FeedFilters } from '../types';
import { buildArticleQuery } from '../utils/feedUtils';

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
                            "keyFindings": 1,
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

  // --- 3. NEW: Triple-Zone Latest Feed ---
  async getMainFeed(filters: FeedFilters, userId?: string) {
    const { offset = 0, limit = 20 } = filters;
    const page = Number(offset);

    // ZONE 3: Deep Scrolling (Strict Chronological)
    // If paging deep, we skip the heavy math and just return time-sorted articles
    if (page >= 30) {
         const query = buildArticleQuery(filters);
         (query as any).analysisVersion = { $ne: 'pending' };
         // Explicitly exclude Narratives (they are in In Focus now)
         
         const articles = await Article.find(query)
            .select('-content -embedding -recommendations')
            .sort({ publishedAt: -1 })
            .skip(page)
            .limit(Number(limit))
            .lean()
            .read('secondaryPreferred');

         return { 
             articles: articles.map(a => ({...a, type: 'Article', imageUrl: optimizeImageUrl(a.imageUrl)})), 
             pagination: { total: 1000 } // Estimate
         };
    }

    // ZONE 1 & 2: The "Smart Head" (Only computed on first load)
    // 1. Fetch Candidates (Mix of Trending & Latest)
    const [latestCandidates, userProfile] = await Promise.all([
        Article.find({ analysisVersion: { $ne: 'pending' } })
           .sort({ publishedAt: -1 }) // Get recent first
           .limit(60) // Pool to select from
           .select('-content -embedding')
           .lean(),
        userId ? Profile.findOne({ userId }).select('userEmbedding') : null
    ]);

    // 2. Score Candidates (Weighted Merge Logic)
    const scoredCandidates = latestCandidates.map((article: any) => {
        let score = 0;
        
        // A. Recency Score (0-50 pts) - Decay over 24h
        const hoursOld = (Date.now() - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
        score += Math.max(0, 50 - (hoursOld * 2));

        // B. Importance Score (0-30 pts)
        if (article.trustScore > 80) score += 10;
        if (article.clusterCount > 3) score += 10;
        if (article.biasScore < 20) score += 10;

        // C. Personalization Score (Fake implementation for speed, assumes vector search already filtered if we used it)
        // In a real implementation, we would do a dot product here if we had the vector loaded.
        
        return { article, score };
    });

    // 3. Zone 1: The "Must Know" (Top 15 by Score)
    // We pick the best 15, BUT we sort them by Time (Latest First) as requested.
    const sortedByScore = [...scoredCandidates].sort((a, b) => b.score - a.score);
    const zone1 = sortedByScore.slice(0, 15).map(i => i.article)
        .sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    const zone1Ids = new Set(zone1.map(a => a._id.toString()));

    // 4. Zone 2: The "Mix Tape" (Next 15 Shuffled)
    const remainder = scoredCandidates.filter(i => !zone1Ids.has(i.article._id.toString()));
    const zone2Pool = remainder.slice(0, 15);
    const zone2 = zone2Pool.map(i => i.article).sort(() => Math.random() - 0.5);

    // 5. Zone 3: The Rest (Time Sorted)
    const usedIds = new Set([...zone1Ids, ...zone2.map(a => a._id.toString())]);
    const zone3 = latestCandidates
        .filter(a => !usedIds.has(a._id.toString()))
        .sort((a: any, b: any) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    // Assemble Full Feed
    const feed = [...zone1, ...zone2, ...zone3];

    // Handle Slice for this specific request
    const pagedFeed = feed.slice(page, page + Number(limit));

    return { 
        articles: pagedFeed.map(a => ({ 
            ...a, 
            type: 'Article', 
            imageUrl: optimizeImageUrl(a.imageUrl) 
        })), 
        pagination: { total: 1000 } 
    };
  }

  // --- 4. NEW: In Focus Feed (Narratives Only) ---
  async getInFocusFeed(filters: FeedFilters) {
     const query: any = {
         lastUpdated: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
     };
     
     if (filters.category && filters.category !== 'All') {
         query.category = filters.category;
     }

     const narratives = await Narrative.find(query)
         .select('-articles -vector') // Keep it light
         .sort({ lastUpdated: -1 })
         .limit(20)
         .lean();

     return {
         articles: narratives.map(n => ({
             ...n,
             type: 'Narrative',
             publishedAt: n.lastUpdated 
         })),
         meta: { description: "Top Developing Stories" }
     };
  }

  // --- 5. NEW: Balanced Feed (Anti-Echo Chamber) ---
  // Replaces the old "For You" Logic with smarter UserStats logic
  async getBalancedFeed(userId: string) {
      if (!userId) return this.getMainFeed({ limit: 20 }, undefined);

      const stats = await UserStats.findOne({ userId });
      
      // Default Query
      let query: any = { 
          analysisVersion: { $ne: 'pending' },
          publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
      };

      let reason = "Global Perspectives";

      if (stats) {
          const { Left, Right } = stats.leanExposure;
          const total = Left + Right + stats.leanExposure.Center;
          
          if (total > 5) { // Only calculate if we have >5 mins of data
              if (Left > Right * 1.5) {
                  // User is Heavy Left -> Show High Quality Right/Center
                  query.politicalLean = { $in: ['Right', 'Right-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 }; // High quality only
                  reason = "Perspectives from Center & Right";
              } else if (Right > Left * 1.5) {
                  // User is Heavy Right -> Show High Quality Left/Center
                  query.politicalLean = { $in: ['Left', 'Left-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 };
                  reason = "Perspectives from Center & Left";
              } else {
                  // User is Balanced -> Show "Challenging" complex topics
                  query.biasScore = { $lt: 15 }; // Extremely neutral/dense
                  reason = "Deep Dive & Neutral Analysis";
              }
          }
      }

      const articles = await Article.find(query)
          .select('-content -embedding')
          .sort({ trustScore: -1, publishedAt: -1 })
          .limit(20)
          .lean();

      return {
          articles: articles.map(a => ({ 
              ...a, 
              type: 'Article', 
              imageUrl: optimizeImageUrl(a.imageUrl), 
              suggestionType: 'Challenge' 
          })),
          meta: { reason }
      };
  }

  // --- 6. Personalized Feed (Legacy / Backup) ---
  // Kept to ensure we don't break existing endpoints, but mostly covered by Main Feed now.
  async getPersonalizedFeed(userId: string) {
    const CACHE_KEY = `my_mix_v2:${userId}`;
    
    return redis.getOrFetch(CACHE_KEY, async () => {
        const profile = await Profile.findOne({ userId }).select('userEmbedding').lean();
        if (!profile?.userEmbedding?.length) return { articles: [], meta: { reason: "No profile" }};

        // Standard Vector Search
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
                        "audioUrl": 1, "keyFindings": 1,
                        "score": { "$meta": "vectorSearchScore" } 
                    } 
                }
            ];
            const articles = await Article.aggregate(pipeline);
            return { 
                articles: articles.map(a => ({ ...a, suggestionType: 'Comfort', imageUrl: optimizeImageUrl(a.imageUrl) })), 
                meta: { topCategories: ["AI Curated"] } 
            };
        } catch (error) {
            logger.error(`Vector Search Failed: ${error}`);
            return { articles: [], meta: { reason: "Error" }};
        }
    }, CONSTANTS.CACHE.TTL_PERSONAL);
  }

  // --- 7. Saved Articles ---
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

  // --- 8. Toggle Save ---
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
