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

// --- ADVANCED HYBRID DEDUPLICATION ---

// 1. Text Normalizer: Handles "U.S." -> "us", "US-Iran" -> "us iran"
const getTokens = (str: string) => {
    return str.toLowerCase()
        .replace(/\./g, '') // Remove dots (U.S. -> US)
        .replace(/[^\w\s]/g, ' ') // Replace punctuation with space (US-Iran -> US Iran)
        .split(/\s+/)
        .filter(t => t.length > 2) // Ignore tiny words
        .sort(); // Sort for order-independent comparison
};

// 2. Smart String Matcher
const areTopicsLinguisticallySimilar = (topicA: string, topicB: string) => {
    const tokensA = getTokens(topicA);
    const tokensB = getTokens(topicB);
    
    // A. Exact Token Set Match (Handles "US-Iran" vs "Iran-US")
    const strA = tokensA.join(' ');
    const strB = tokensB.join(' ');
    if (strA === strB) return true;
    
    // B. Root Word/Substring Match (Handles "Iran" vs "Iranian")
    let matches = 0;
    const total = Math.max(tokensA.length, tokensB.length);
    if (total === 0) return false;

    for (const tA of tokensA) {
        for (const tB of tokensB) {
            // Check exact match OR containment (e.g. "iran" is in "iranian")
            if (tA === tB || tA.includes(tB) || tB.includes(tA)) {
                matches++;
                break; // Move to next token in A
            }
        }
    }
    
    // If > 70% of the words match/overlap, they are the same topic
    return (matches / total) >= 0.7; 
};

const deduplicateTopics = (rawTopics: any[]) => {
    const uniqueTopics: any[] = [];
    
    // Sort by count DESC to keep the most popular version
    const sorted = rawTopics.sort((a, b) => b.count - a.count);

    for (const item of sorted) {
        // Find existing match using HYBRID check
        const existingIndex = uniqueTopics.findIndex(u => {
            // Check 1: Linguistic Match (Fast & Explicit)
            // Catches "US-Iran" == "Iran-US" and "Iran" == "Iranian"
            if (areTopicsLinguisticallySimilar(u.topic, item.topic)) return true;

            // Check 2: Vector Match (Semantic Fallback)
            // Catches "Gaza Conflict" == "Israel-Hamas War"
            const sim = calculateSimilarity(u.vector, item.vector);
            
            const timeDiff = Math.abs(new Date(u.latestDate).getTime() - new Date(item.latestDate).getTime());
            const hoursDiff = timeDiff / (1000 * 60 * 60);

            // Relaxed threshold to 0.92 to catch tone variations
            return sim > 0.92 && hoursDiff < 24;
        });

        if (existingIndex !== -1) {
            // Merge Counts
            uniqueTopics[existingIndex].count += item.count;
            
            // Label Logic: Keep the one that is "Prettier" (usually longer, unless the shorter one is an acronym)
            // But prefer the one with correct capitalization (usually from the DB group key)
            if (item.topic.length > uniqueTopics[existingIndex].topic.length) {
                 uniqueTopics[existingIndex].topic = item.topic;
            }
        } else {
            uniqueTopics.push({ ...item });
        }
    }
    
    return uniqueTopics;
};

class ArticleService {
  
  // --- SMART INJECTION LOGIC (NEW) ---

  /**
   * Calculates the "Thermostat" setting for the user.
   * Returns the target lean to inject and the frequency (1 in N).
   */
  private getInjectionStrategy(stats: any): { targetLean: string[], frequency: number, intensity: string } {
      if (!stats || !stats.leanExposure) {
          return { targetLean: ['Center', 'Balanced'], frequency: 7, intensity: 'Low' }; // Default: 1 in 7
      }

      const { Left = 0, Right = 0, Center = 0 } = stats.leanExposure;
      const total = Left + Right + Center;
      
      // Cold start: Inject neutral
      if (total < 10) return { targetLean: ['Center'], frequency: 7, intensity: 'Neutral' };

      const leftRatio = Left / total;
      const rightRatio = Right / total;

      // CASE 1: High Left Exposure -> Inject Right
      if (leftRatio > 0.65) {
          const freq = leftRatio > 0.8 ? 3 : 5; // If extreme (>80%), inject every 3rd. Else every 5th.
          return { targetLean: ['Right', 'Right-Leaning'], frequency: freq, intensity: 'High' };
      }

      // CASE 2: High Right Exposure -> Inject Left
      if (rightRatio > 0.65) {
          const freq = rightRatio > 0.8 ? 3 : 5;
          return { targetLean: ['Left', 'Left-Leaning'], frequency: freq, intensity: 'High' };
      }

      // CASE 3: Echo Chamber (Too much matching Center/Safe content) -> Inject Conflict
      if ((Center / total) > 0.8) {
           return { targetLean: ['Left', 'Right'], frequency: 6, intensity: 'Diversify' };
      }

      // CASE 4: Balanced User -> Inject Complexity (Deep Dives)
      return { targetLean: ['Center', 'Balanced'], frequency: 8, intensity: 'Maintenance' };
  }

  // --- 1. Smart Trending Topics (7 Days + Hybrid Dedupe) ---
  async getTrendingTopics() {
    // CACHE BUST: 'v14' - Updated to 7 Days
    return redis.getOrFetch(
        'trending_topics_v14', 
        async () => {
            // UPDATED: Extended from 72h to 7 days to match clustering window
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            // 1. Fetch Candidates
            const rawResults = await Article.aggregate([
                { 
                    $match: { 
                        publishedAt: { $gte: sevenDaysAgo }, 
                        clusterTopic: { $exists: true, $ne: "" } 
                    } 
                },
                { $sort: { publishedAt: -1 } }, 
                { 
                    $group: { 
                        _id: "$clusterTopic", 
                        count: { $sum: 1 }, 
                        sampleScore: { $max: "$trustScore" },
                        latestVector: { $first: "$embedding" },
                        latestDate: { $first: "$publishedAt" }
                    } 
                },
                { 
                    $match: { 
                        count: { $gte: 3 }, 
                        _id: { $ne: "General" } 
                    } 
                }, 
                { $sort: { count: -1 } },
                { $limit: 60 } // Fetch more candidates to allow for merging
            ]).read('secondaryPreferred'); 

            const candidateList = rawResults.map(r => ({ 
                topic: r._id, 
                count: r.count, 
                score: r.sampleScore,
                vector: r.latestVector || [], 
                latestDate: r.latestDate
            }));

            // 2. Hybrid Deduplication (Text + Vector)
            const cleanList = deduplicateTopics(candidateList);

            // 3. Return Top 12
            return cleanList
                .sort((a, b) => b.count - a.count)
                .slice(0, 12)
                .map(({ vector, latestDate, ...rest }) => rest);
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
            articles = rawArticles.slice(0, limit);
        }

        articles = articles.map(a => ({ ...a, imageUrl: optimizeImageUrl(a.imageUrl) }));
        logger.info(`🔍 Search: "${safeQuery}" | Method: ${searchMethod} | Results: ${articles.length}`);
        return { articles, total: articles.length };
    }, CONSTANTS.CACHE.TTL_SEARCH);
  }

  // --- 3. THE SMART FEED (RESTORED SCORING + SLIDING WINDOW FALLBACK) ---
  async getMainFeed(filters: FeedFilters, userId?: string) {
    const { offset = 0, limit = 20 } = filters;
    const page = Number(offset);

    // A. FILTER MODE (Skip injection if user is filtering specifically)
    if (filters.topic || (filters.category && filters.category !== 'All') || filters.politicalLean) {
         // Standard filtered query
         const query = buildArticleQuery(filters);
         
         if (filters.topic) {
             const cleanTopic = filters.topic.replace(/[^\w\s]/g, '').replace(/\s+/g, '.*'); 
             query.$or = [
                 { clusterTopic: filters.topic }, 
                 { clusterTopic: { $regex: new RegExp(cleanTopic, 'i') } } 
             ];
             delete query.topic; 
         }

         const articles = await Article.find(query)
            .sort({ publishedAt: -1 })
            .skip(page)
            .limit(Number(limit))
            .lean()
            .read('secondaryPreferred');

         return { 
             articles: articles.map(a => ({ 
                 ...a, 
                 type: 'Article', 
                 imageUrl: optimizeImageUrl(a.imageUrl) 
             })), 
             pagination: { total: 100 } 
         };
    }

    // B. DEEP SCROLL MODE (Page 2+) 
    // Optimization: Skip heavy personalization logic after page 2
    if (page >= 40) {
         const articles = await Article.find({ 
             publishedAt: { $gte: new Date(Date.now() - 72*3600*1000) },
             trustScore: { $gt: 40 }
         })
            .sort({ publishedAt: -1 })
            .skip(page)
            .limit(Number(limit))
            .lean();
            
         return { 
             articles: articles.map(a => ({...a, type: 'Article', imageUrl: optimizeImageUrl(a.imageUrl)})), 
             pagination: { total: 1000 } 
         };
    }

    // C. SMART MIXER + PERSONALIZED SCORING (With Fallback)
    
    // 1. Fetch User Stats (Thermostat & Affinity)
    let injectionStrategy = { targetLean: ['Center'], frequency: 7, intensity: 'Neutral' };
    let userProfile: any = null; 
    let userStats: any = null;    
    
    if (userId) {
        const [stats, profile] = await Promise.all([
            UserStats.findOne({ userId }).select('leanExposure topicInterest'),
            Profile.findOne({ userId }).select('userEmbedding')
        ]);
        if (stats) {
            injectionStrategy = this.getInjectionStrategy(stats);
            userStats = stats;
        }
        userProfile = profile;
    }

    // 2. FETCH BASE CONTENT (Sliding Window Fallback)
    const poolSize = 80;
    let rawBaseCandidates: any[] = [];

    // Attempt 1: Recent High Quality (48h)
    rawBaseCandidates = await Article.find({ 
        publishedAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
        trustScore: { $gt: 40 } 
    })
    .sort({ publishedAt: -1 })
    .limit(poolSize)
    .select('+embedding')
    .lean();

    // Attempt 2: Weekly High Quality (7 Days) - Fallback if recent is empty
    if (rawBaseCandidates.length < 10) {
        logger.info(`[SmartFeed] 48h pool low (${rawBaseCandidates.length}). Extending to 7 days.`);
        rawBaseCandidates = await Article.find({ 
            publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            trustScore: { $gt: 40 } 
        })
        .sort({ publishedAt: -1 })
        .limit(poolSize)
        .select('+embedding')
        .lean();
    }

    // Attempt 3: ULTIMATE FALLBACK (Standard Chronological Feed)
    // If we still don't have enough high-quality articles, return a simple chronological feed
    // so the user never sees an empty screen.
    if (rawBaseCandidates.length < 5) {
        logger.info(`[SmartFeed] High-trust pool empty. Falling back to Standard Chronological Feed.`);
        
        const articles = await Article.find({}) // All articles
            .sort({ publishedAt: -1 })
            .skip(page)
            .limit(Number(limit))
            .lean()
            .read('secondaryPreferred');

        return { 
            articles: articles.map(a => ({ 
                ...a, 
                type: 'Article', 
                imageUrl: optimizeImageUrl(a.imageUrl),
                suggestionType: 'Latest News' // UI hint
            })), 
            pagination: { total: 1000 } 
        };
    }

    // 3. SCORE CANDIDATES (The restored logic)
    const scoredCandidates = rawBaseCandidates.map((article: any) => {
        let score = 0;
        
        // Recency Decay
        const hoursOld = (Date.now() - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60);
        score += Math.max(0, 40 - (hoursOld * 1.5));

        // Quality Bonuses
        if (article.trustScore > 85) score += 10;
        if (article.clusterId && article.isLatest) score += 10; 
        if (article.biasScore < 15) score += 5; 

        // Personalization (Vector + Interest)
        const userVec = (userProfile as any)?.userEmbedding;
        if (userVec && article.embedding) {
            const sim = calculateSimilarity(userVec, article.embedding);
            score += Math.max(0, (sim - 0.5) * 100); 
        } else if (userStats) {
            if (userStats.topicInterest && userStats.topicInterest[article.category] > 60) score += 20;
            const leanKey = mapLeanToKey(article.politicalLean);
            if (userStats.leanExposure[leanKey] > userStats.leanExposure.Center) score += 10;
        }

        const { embedding, ...cleanArticle } = article;
        return { article: cleanArticle, score };
    });

    // Select Top Base Articles based on Personal Score
    const baseLimit = Math.ceil(Number(limit) * 0.8);
    const baseArticles = scoredCandidates
        .sort((a, b) => b.score - a.score) // High score first
        .slice(0, baseLimit + 5) // Buffer
        .map(i => i.article);

    
    // 4. FETCH INJECTION CONTENT (Perspective Wideners)
    const injectionLimit = Math.floor(Number(limit) * 0.3); 
    const injectionQuery = {
        publishedAt: { $gte: new Date(Date.now() - 96 * 60 * 60 * 1000) }, // Wider time window
        politicalLean: { $in: injectionStrategy.targetLean },
        trustScore: { $gt: 80 } 
    };

    const injectionCandidates = await Article.find(injectionQuery)
        .sort({ trustScore: -1 })
        .limit(injectionLimit)
        .lean();

    // 5. THE MIXER (Interleaving)
    const finalFeed: any[] = [];
    const usedIds = new Set<string>();

    let injectionIndex = 0;
    let baseIndex = 0;

    // Skip redundant base articles if they appear in pagination
    if (page > 0) {
        baseIndex = page % baseLimit; // approximate offset logic for simplicity in this view
    }

    for (let i = 0; i < Number(limit); i++) {
        const isInjectionSlot = (i + 1) % injectionStrategy.frequency === 0;
        
        // Attempt Injection
        if (isInjectionSlot && injectionIndex < injectionCandidates.length) {
            const candidate = injectionCandidates[injectionIndex];
            if (!usedIds.has(candidate._id.toString())) {
                finalFeed.push({ ...candidate, suggestionType: 'Perspective' }); // Flag for UI
                usedIds.add(candidate._id.toString());
                injectionIndex++;
                continue;
            }
        }

        // Standard Article
        if (baseIndex < baseArticles.length) {
             const candidate = baseArticles[baseIndex];
             if (!usedIds.has(candidate._id.toString())) {
                 finalFeed.push(candidate);
                 usedIds.add(candidate._id.toString());
                 baseIndex++;
             } else {
                 baseIndex++; // Skip duplicate
                 i--; // Retry slot
             }
        }
    }

    // Fill remaining slots
    while (finalFeed.length < Number(limit) && baseIndex < baseArticles.length) {
        const candidate = baseArticles[baseIndex];
        if (!usedIds.has(candidate._id.toString())) {
            finalFeed.push(candidate);
            usedIds.add(candidate._id.toString());
        }
        baseIndex++;
    }

    logger.info(`feed_gen user=${userId || 'guest'} strategy=${injectionStrategy.intensity} items=${finalFeed.length}`);

    return { 
        articles: finalFeed.map(a => ({ 
            ...a, 
            type: 'Article', 
            imageUrl: optimizeImageUrl(a.imageUrl) 
        })), 
        pagination: { total: 1000 } 
    };
  }

  // --- 4. In Focus Feed (RESTORED) ---
  async getInFocusFeed(filters: FeedFilters) {
     const { offset = 0, limit = 20 } = filters;
     const query: any = {};
     if (filters.category && filters.category !== 'All') {
         query.category = { $regex: filters.category, $options: 'i' };
     }

     let narratives: any[] = [];
     try {
         narratives = await Narrative.find(query)
             .select('-articles -vector') 
             .sort({ lastUpdated: -1 })
             .skip(Number(offset))
             .limit(Number(limit))
             .lean();

         if (narratives.length === 0 && Number(offset) === 0) {
             narratives = await Narrative.find({})
                 .select('-articles -vector')
                 .sort({ lastUpdated: -1 })
                 .limit(Number(limit))
                 .lean();
         }
     } catch (err) {
         logger.error(`[InFocus] Error: ${err}`);
         narratives = [];
     }

     if (narratives.length === 0) {
         const fallbackArticles = await Article.find(query)
             .select('-content -embedding')
             .sort({ publishedAt: -1 }) 
             .skip(Number(offset))
             .limit(Number(limit))
             .lean();

         return {
             articles: fallbackArticles.map(a => ({
                 ...a,
                 type: 'Article',
                 imageUrl: optimizeImageUrl(a.imageUrl)
             })),
             meta: { description: "Top Headlines" }
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

  // --- 5. Balanced Feed (Legacy Wrapper) ---
  async getBalancedFeed(userId: string) {
      // Return getMainFeed results but format it to allow fallback compatibility if needed
      const result = await this.getMainFeed({ limit: 20 }, userId);
      return {
          articles: result.articles,
          meta: { reason: "Merged with Main Feed" } // Dummy meta to satisfy controller expectation
      };
  }

  // --- 6. Personalized Feed (Legacy Wrapper) ---
  async getPersonalizedFeed(userId: string) {
      const result = await this.getMainFeed({ limit: 20 }, userId);
      return {
          articles: result.articles,
          meta: { topCategories: ["Merged Mix"] } // Dummy meta
      };
  }

  // --- 7. Saved Articles (RESTORED) ---
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

  // --- 8. Toggle Save (RESTORED) ---
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
