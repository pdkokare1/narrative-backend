// services/clusteringService.ts
import Article from '../models/articleModel';
import Narrative from '../models/narrativeModel';
import redis from '../utils/redisClient';
import { IArticle } from '../types';
import logger from '../utils/logger';
import aiService from './aiService';

// --- HELPER: Optimized String Similarity ---
function getStringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const s2 = str2.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const len1 = s1.length;
    const len2 = s2.length;

    if (len1 > len2) return getStringSimilarity(s2, s1);

    let prevRow = new Array(len1 + 1);
    let currRow = new Array(len1 + 1);

    for (let i = 0; i <= len1; i++) {
        prevRow[i] = i;
    }

    for (let j = 1; j <= len2; j++) {
        currRow[0] = j;
        for (let i = 1; i <= len1; i++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            currRow[i] = Math.min(
                currRow[i - 1] + 1,     // insertion
                prevRow[i] + 1,         // deletion
                prevRow[i - 1] + cost   // substitution
            );
        }
        [prevRow, currRow] = [currRow, prevRow];
    }

    const distance = prevRow[len1];
    const maxLength = Math.max(len1, len2);
    
    return 1 - (distance / maxLength);
}

class ClusteringService {

    // --- Stage 1: Fast Fuzzy Match ---
    async findSimilarHeadline(headline: string): Promise<IArticle | null> {
        if (!headline || headline.length < 5) return null;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        try {
            const candidates = await Article.find({ 
                $text: { $search: headline }, 
                publishedAt: { $gte: oneDayAgo } 
            })
            .limit(15) 
            .select('headline clusterId clusterTopic') 
            .lean();

            let bestMatch: any = null;
            let bestScore = 0;

            for (const candidate of candidates) {
                const score = getStringSimilarity(headline, candidate.headline);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = candidate;
                }
            }

            if (bestScore > 0.80 && bestMatch) {
                return bestMatch as IArticle;
            }

        } catch (error: any) { 
            logger.warn(`⚠️ Clustering Fuzzy Match warning: ${error.message}`);
        }

        return null;
    }

    // --- Stage 2: Vector Search ---
    async findSemanticDuplicate(embedding: number[] | undefined, country: string): Promise<IArticle | null> {
        if (!embedding || embedding.length === 0) return null;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        try {
            const pipeline: any = [
                {
                    "$vectorSearch": {
                        "index": "vector_index",
                        "path": "embedding",
                        "queryVector": embedding,
                        "numCandidates": 10, 
                        "limit": 1,          
                        "filter": {
                            "country": { "$eq": country }
                        }
                    }
                },
                {
                    "$project": {
                        "clusterId": 1, "headline": 1, "score": { "$meta": "vectorSearchScore" } 
                    }
                },
                { "$match": { "publishedAt": { "$gte": oneDayAgo } } }
            ];

            const candidates = await Article.aggregate(pipeline);

            if (candidates.length > 0 && candidates[0].score >= 0.92) {
                return candidates[0] as IArticle;
            }
        } catch (error) { /* Ignore vector errors */ }
        
        return null;
    }

    // --- Stage 3: Assign Cluster ID ---
    async assignClusterId(newArticleData: Partial<IArticle>, embedding: number[] | undefined): Promise<number> {
        
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        let finalClusterId = 0;
        
        // 1. Try Vector Matching
        if (embedding && embedding.length > 0) {
            try {
                const pipeline: any = [
                    {
                        "$vectorSearch": {
                            "index": "vector_index",
                            "path": "embedding",
                            "queryVector": embedding,
                            "numCandidates": 50, 
                            "limit": 1,          
                            "filter": { "country": { "$eq": newArticleData.country } }
                        }
                    },
                    { "$project": { "clusterId": 1, "score": { "$meta": "vectorSearchScore" } } },
                    { "$match": { "publishedAt": { "$gte": sevenDaysAgo } } }
                ];

                const candidates = await Article.aggregate(pipeline);

                if (candidates.length > 0 && candidates[0].score >= 0.82) {
                    finalClusterId = candidates[0].clusterId;
                }
            } catch (error) { /* Silent fallback */ }
        }

        // 2. Fallback: Field Match 
        if (finalClusterId === 0 && newArticleData.clusterTopic) {
            const existingCluster = await Article.findOne({
                clusterTopic: newArticleData.clusterTopic,
                category: newArticleData.category,
                country: newArticleData.country,
                publishedAt: { $gte: sevenDaysAgo }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) {
                finalClusterId = existingCluster.clusterId;
            }
        }

        // 3. Generate NEW Cluster ID
        if (finalClusterId === 0) {
            try {
                if (redis.isReady()) {
                    let newId = await redis.incr('GLOBAL_CLUSTER_ID');
                    
                    if (newId < 100) {
                        const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                        const dbMax = maxIdDoc?.clusterId || 10000;
                        
                        if (dbMax >= newId) {
                            const client = redis.getClient();
                            if (client) {
                                await client.set('GLOBAL_CLUSTER_ID', dbMax + 1);
                                newId = dbMax + 1;
                            }
                        }
                    }
                    finalClusterId = newId;
                } else {
                    finalClusterId = Math.floor(Date.now() / 1000); 
                }
            } catch (err) {
                finalClusterId = Math.floor(Date.now() / 1000); 
            }
        }

        // --- NEW: Trigger Narrative Check (Fire and Forget) ---
        // We delay slightly to allow the caller to save the current article first
        setTimeout(() => {
             this.processClusterForNarrative(finalClusterId).catch(err => {
                 logger.warn(`Background Narrative Gen Error for Cluster ${finalClusterId}: ${err.message}`);
             });
        }, 5000);

        return finalClusterId;
    }

    // --- Stage 4: Narrative Synthesis (The "Brain") ---
    // Checks if we have enough articles to form a "Meta-Narrative"
    async processClusterForNarrative(clusterId: number): Promise<void> {
        // 1. Check if we already have a fresh narrative (generated in last 12 hours)
        const existingNarrative = await Narrative.findOne({ clusterId });
        if (existingNarrative) {
            const hoursOld = (Date.now() - new Date(existingNarrative.lastUpdated).getTime()) / (1000 * 60 * 60);
            if (hoursOld < 12) return; // Skip if fresh
        }

        // 2. Fetch Articles in this cluster
        const articles = await Article.find({ clusterId })
                                      .sort({ publishedAt: -1 })
                                      .limit(10) // Analyze max 10 top articles
                                      .lean();

        // 3. Threshold: Need MORE THAN 3 distinct sources (>= 4)
        if (articles.length <= 3) return; // Count check

        const distinctSources = new Set(articles.map(a => a.source));
        if (distinctSources.size <= 3) return; // Strict source uniqueness check

        logger.info(`🧠 Triggering Narrative Synthesis for Cluster ${clusterId} (${articles.length} articles, ${distinctSources.size} sources)...`);

        // 4. Generate Narrative using Gemini 2.5 Pro
        // @ts-ignore
        const narrativeData = await aiService.generateNarrative(articles);

        if (narrativeData) {
            // 5. Save/Update Narrative
            await Narrative.findOneAndUpdate(
                { clusterId },
                {
                    clusterId,
                    lastUpdated: new Date(),
                    masterHeadline: narrativeData.masterHeadline,
                    executiveSummary: narrativeData.executiveSummary,
                    consensusPoints: narrativeData.consensusPoints,
                    divergencePoints: narrativeData.divergencePoints,
                    sourceCount: articles.length,
                    sources: Array.from(distinctSources),
                    category: articles[0].category,
                    country: articles[0].country
                },
                { upsert: true, new: true }
            );
            logger.info(`✅ Narrative Generated for Cluster ${clusterId}`);
        }
    }
}

export default new ClusteringService();
