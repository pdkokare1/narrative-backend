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

// Helper: Safely map raw political lean strings to UserStats keys
const mapLeanToKey = (lean: string): 'Left' | 'Right' | 'Center' => {
    if (!lean) return 'Center';
    if (lean.includes('Left') || lean.includes('Liberal')) return 'Left';
    if (lean.includes('Right') || lean.includes('Conservative')) return 'Right';
    return 'Center';
};

class ArticleService {
  
  // --- 1. Smart Trending Topics ---
  async getTrendingTopics() {
    // CACHE BUST: Hardcoded 'v5' key to force clear any empty cache from previous runs
    return redis.getOrFetch(
        'trending_topics_v5', 
        async () => {
            // UPDATED: Widen window to 30 days to ensure data shows even in dev/test environments
            const searchWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            
            const results = await Article.aggregate([
                { 
                    $match: { 
                        publishedAt: { $gte: searchWindow }, 
                        // Relaxed: Removed analysisVersion check to show even partial data if needed
                    } 
                },
                { 
                    $group: { 
                        // Logic: Prefer clusterTopic -> Category -> Source -> "General"
                        _id: { $ifNull: ["$clusterTopic", "$category", "$source", "General"] }, 
                        count: { $sum: 1 }, 
                        sampleScore: { $max: "$trustScore" } 
                    } 
                },
                { $match: { count: { $gte: 1 }, _id: { $ne: null } } }, // Threshold 1 ensures even single articles create a topic
                { $sort: { count: -1 } },
                { $limit: 12 }
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
        const userVec = (userProfile as any)?.userEmbedding;
        
        if (userVec && article.embedding) {
            // Precise Vector Match
            const sim = calculateSimilarity(userVec, article.embedding);
            score += Math.max(0, (sim - 0.5) * 100); 
        } else if (userStats) {
            // Heuristic Match (Fallback)
            if (userStats.topicInterest && userStats.topicInterest[article.category] > 60) score += 20;
            const leanKey = mapLeanToKey(article.politicalLean);
            if (userStats.leanExposure[leanKey] > userStats.leanExposure.Center) score += 10;
        }

        // Cleanup heavy embedding before returning
        const { embedding, ...cleanArticle } = article;
        return { article: cleanArticle, score };
    });

    // 3. Construct Zones
    const sorted = scoredCandidates.sort((a, b) => b.score - a.score);

    // Zone 1: Top 10 "Must Reads"
    const zone1 = sorted.slice(0, 10).map(i => i.article);
    const zone1Ids = new Set(zone1.map(a => a._id.toString()));

    // Zone 2: "Discovery Mix" (Next 20 candidates, shuffled)
    const zone2Candidates = sorted.slice(10, 30).filter(i => !zone1Ids.has(i.article._id.toString()));
    const zone2 = zone2Candidates
        .map(i => i.article)
        .sort(() => Math.random() - 0.5); 

    // Assemble
    const mixedFeed = [...zone1, ...zone2];
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

  // --- 4. In Focus Feed (Narratives OR Top Stories) ---
  async getInFocusFeed(filters: FeedFilters) {
     const { offset = 0, limit = 20 } = filters;
     
     const query: any = {};
     if (filters.category && filters.category !== 'All') {
         query.category = filters.category;
     }

     // 1. Try to fetch Narratives (Clustered Stories)
     const narratives = await Narrative.find(query)
         .select('-articles -vector') 
         .sort({ lastUpdated: -1 })
         .skip(Number(offset))
         .limit(Number(limit))
         .lean();

     // UPDATED: PERMISSIVE FALLBACK LOGIC
     // If no narratives, return Articles.
     if (narratives.length === 0) {
         const articleQuery = { 
             ...query, 
             // Removed trustScore requirement entirely to ensure data shows up.
             // Only require that the article is not stuck in "pending" analysis.
             analysisVersion: { $ne: 'pending' } 
         };

         const fallbackArticles = await Article.find(articleQuery)
             .select('-content -embedding')
             .sort({ publishedAt: -1 }) // Strictly latest first
             .skip(Number(offset))
             .limit(Number(limit))
             .lean();

         return {
             articles: fallbackArticles.map(a => ({
                 ...a,
                 type: 'Article', // Frontend will render this as a standard card
                 imageUrl: optimizeImageUrl(a.imageUrl)
             })),
             meta: { description: "Top Headlines (Developing)" }
         };
     }

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
      if (!userId) {
          // Fallback: If no user, fetch standard feed but wrap it to match type
          const feed = await this.getMainFeed({ limit: 20 });
          return { 
              articles: feed.articles, 
              meta: { reason: "Trending Headlines" } 
          };
      }

      const stats = await UserStats.findOne({ userId });
      
      let query: any = { 
          analysisVersion: { $ne: 'pending' },
          publishedAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
      };

      let reason = "Global Perspectives";

      if (stats) {
          const { Left, Right } = stats.leanExposure;
          const total = Left + Right + stats.leanExposure.Center;
          
          if (total > 300) { 
              if (Left > Right * 1.5) {
                  query.politicalLean = { $in: ['Right', 'Right-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 }; 
                  reason = "Perspectives from Center & Right";
              } else if (Right > Left * 1.5) {
                  query.politicalLean = { $in: ['Left', 'Left-Leaning', 'Center'] };
                  query.trustScore = { $gt: 80 };
                  reason = "Perspectives from Center & Left";
              } else {
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
        if (!profile || !(profile as any).userEmbedding?.length) return { articles: [], meta: { reason: "No profile" }};

        try {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            const pipeline: any = [
                {
                    "$vectorSearch": {
                        "index": "vector_index",
                        "path": "embedding",
                        "queryVector": (profile as any).userEmbedding,
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
