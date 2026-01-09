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

// Helper: Cosine Similarity for Vector Matching
const calculateSimilarity = (vecA: number[], vecB: number[]) => {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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

  // --- 3. Weighted Merge Main Feed (Triple Zone) ---
  // Strategy: 40% Trending + 40% Personalized + 20% Latest
  async getMainFeed(filters: FeedFilters, userId?: string) {
    const { offset = 0, limit = 20 } = filters;
    const page = Number(offset);

    // ZONE 3: Deep Scrolling (Optimized)
    // If paging deep (> 20 items), skip the heavy math and return strictly chronological
    if (page >= 20) {
         const query = buildArticleQuery(filters);
         (query as any).analysisVersion = { $ne: 'pending' };
         
         const articles = await Article.find(query)
            .select('-content -embedding -recommendations')
            .sort({ publishedAt: -1 })
            .skip(page)
            .limit(Number(limit))
            .lean()
            .read('secondaryPreferred');

         return { 
             articles: articles.map(a => ({...a, type: 'Article', imageUrl: optimizeImageUrl(a.imageUrl)})), 
             pagination: { total: 1000 }
         };
    }

    // ZONE 1 & 2: Weighted Construction (First Page Load)
    
    // 1. Fetch Candidates (Pool of ~80 recent articles)
    // We fetch 'embedding' here to calculate personalization on the fly
    const [latestCandidates, userProfile, userStats] = await Promise.all([
        Article.find({ 
            analysisVersion: { $ne: 'pending' },
            publishedAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } // Last 48h
        })
           .sort({ publishedAt: -1 })
           .limit(80) 
           .select('+embedding') // Needed for math
           .lean(),
        userId ? Profile.findOne({ userId }).select('userEmbedding') : null,
        userId ? UserStats.findOne({ userId }).select('leanExposure topicInterest') : null
    ]);

    // 2. Score Candidates
    const scoredCandidates = latestCandidates.map((article: any) => {
        let score = 0;
        
        // A. Recency Score (Base: 0-40 pts)
        // Decays linearly over 24 hours
        const hoursOld = (Date.now() - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
        score += Math.max(0, 40 - (hoursOld * 1.5));

        // B. Importance/Trending Score (0-30 pts)
        if (article.trustScore > 85) score += 10;
        if (article.clusterId && article.isLatest) score += 10; // Part of a cluster
        if (article.biasScore < 15) score += 5; // Neutrality bonus

        // C. Personalization Score (0-40 pts)
        if (userProfile?.userEmbedding && article.embedding) {
            // Precise Vector Match
            const sim = calculateSimilarity(userProfile.userEmbedding, article.embedding);
            // Sim is usually 0.6 to 0.9 for matches. Normalize to 0-40.
            score += Math.max(0, (sim - 0.5) * 100); 
        } else if (userStats) {
            // Heuristic Match (Fallback)
            if (userStats.topicInterest && userStats.topicInterest[article.category] > 60) score += 20;
            const lean = article.politicalLean;
            if (userStats.leanExposure[lean] > userStats.leanExposure.Center) score += 10;
        }

        // Cleanup heavy embedding before returning
        const { embedding, ...cleanArticle } = article;
        return { article: cleanArticle, score };
    });

    // 3. Construct Zones
    // Sort by Total Score
    const sorted = scoredCandidates.sort((a, b) => b.score - a.score);

    // Zone 1: Top 10 "Must Reads" (Highest Weighted Score)
    const zone1 = sorted.slice(0, 10).map(i => i.article);
    const zone1Ids = new Set(zone1.map(a => a._id.toString()));

    // Zone 2: "Discovery Mix" (Next 20 candidates, shuffled for variety)
    const zone2Candidates = sorted.slice(10, 30).filter(i => !zone1Ids.has(i.article._id.toString()));
    const zone2 = zone2Candidates
        .map(i => i.article)
        .sort(() => Math.random() - 0.5); // Shuffle

    // Assemble
    const mixedFeed = [...zone1, ...zone2];
    
    // Ensure we respect the requested limit (likely 20)
    const resultFeed = mixedFeed.slice(0, Number(limit));

    return { 
        articles: resultFeed.map(a => ({ 
            ...a, 
            type: 'Article', 
            imageUrl: optimizeImageUrl(a.imageUrl) 
        })), 
        pagination: { total: 1000 } 
    };
  }

  // --- 4. In Focus Feed (Narratives Only) ---
  async getInFocusFeed(filters: FeedFilters) {
     const query: any = {
         lastUpdated: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
     };
     
     if (filters.category && filters.category !== 'All') {
         query.category = filters.category;
     }

     const narratives = await Narrative.find(query)
         .select('-articles -vector') 
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

  // --- 5. Balanced Feed (Anti-Echo Chamber) ---
  async getBalancedFeed(userId: string) {
      if (!userId) return this.getMainFeed({ limit: 20 }, undefined);

      const stats = await UserStats.findOne({ userId });
      
      let query: any = { 
          analysisVersion: { $ne: 'pending' },
          publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
      };

      let reason = "Global Perspectives";

      if (stats) {
          const { Left, Right } = stats.leanExposure;
          const total = Left + Right + stats.leanExposure.Center;
          
          if (total > 300) { // >5 mins of data (300s)
              if (Left > Right * 1.5) {
                  // User is Left -> Show Right/Center
                  query.politicalLean = { $in: ['Right', 'Right-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 }; 
                  reason = "Perspectives from Center & Right";
              } else if (Right > Left * 1.5) {
                  // User is Right -> Show Left/Center
                  query.politicalLean = { $in: ['Left', 'Left-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 };
                  reason = "Perspectives from Center & Left";
              } else {
                  // User is Balanced -> Show Complex/Neutral
                  query.biasScore = { $lt: 15 }; 
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
  async getPersonalizedFeed(userId: string) {
    const CACHE_KEY = `my_mix_v2:${userId}`;
    
    return redis.getOrFetch(CACHE_KEY, async () => {
        const profile = await Profile.findOne({ userId }).select('userEmbedding').lean();
        if (!profile?.userEmbedding?.length) return { articles: [], meta: { reason: "No profile" }};

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
