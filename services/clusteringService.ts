// services/clusteringService.ts
import Article from '../models/articleModel';
import redis from '../utils/redisClient';
import { IArticle } from '../types';
import logger from '../utils/logger';

// --- HELPER: Optimized String Similarity ---
// Uses a "Two-Row" algorithm (Memory Efficient - O(min(m,n)))
function getStringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const s2 = str2.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const len1 = s1.length;
    const len2 = s2.length;

    // Optimization: Ensure s1 is the shorter string
    if (len1 > len2) return getStringSimilarity(s2, s1);

    let prevRow = new Array(len1 + 1);
    let currRow = new Array(len1 + 1);

    for (let i = 0; i <= len1; i++) prevRow[i] = i;

    for (let j = 1; j <= len2; j++) {
        currRow[0] = j;
        for (let i = 1; i <= len1; i++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            currRow[i] = Math.min(currRow[i - 1] + 1, prevRow[i] + 1, prevRow[i - 1] + cost);
        }
        [prevRow, currRow] = [currRow, prevRow];
    }

    return 1 - (prevRow[len1] / Math.max(len1, len2));
}

class ClusteringService {

    // --- Stage 1: Hybrid Fuzzy Match (CPU Optimized) ---
    async findSimilarHeadline(headline: string): Promise<IArticle | null> {
        if (!headline || headline.length < 5) return null;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        try {
            // 1. Ask MongoDB for candidates + TextScore
            const candidates = await Article.find(
                { $text: { $search: headline }, publishedAt: { $gte: oneDayAgo } },
                { score: { $meta: "textScore" } } 
            )
            .sort({ score: { $meta: "textScore" } }) // Sort by DB relevance
            .limit(10) 
            .select('headline clusterId clusterTopic summary category politicalLean biasScore score') 
            .lean();

            let bestMatch: any = null;
            let bestScore = 0;

            for (const candidate of candidates) {
                // FAST PASS: If DB says it's a huge match, trust it!
                // (Score > 15 is usually an almost exact sentence match)
                if ((candidate as any).score > 15) {
                    return candidate as IArticle;
                }

                // OTHERWISE: Run the JS math
                const similarity = getStringSimilarity(headline, candidate.headline);
                if (similarity > bestScore) {
                    bestScore = similarity;
                    bestMatch = candidate;
                }
            }

            // Threshold: 80% similarity
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
                        "numCandidates": 20, 
                        "limit": 1,          
                        "filter": { "country": { "$eq": country } }
                    }
                },
                { "$project": { "clusterId": 1, "headline": 1, "score": { "$meta": "vectorSearchScore" }, "summary": 1, "category": 1 } },
                { "$match": { "publishedAt": { "$gte": oneDayAgo } } }
            ];

            const candidates = await Article.aggregate(pipeline);

            // High confidence for Semantic Match (92%)
            if (candidates.length > 0 && candidates[0].score >= 0.92) {
                return candidates[0] as IArticle;
            }
        } catch (error) { /* Ignore vector errors */ }
        
        return null;
    }

    // --- Stage 3: Assign Cluster ID ---
    async assignClusterId(newArticleData: Partial<IArticle>, embedding: number[] | undefined): Promise<number> {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching first (Most accurate)
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
                    return candidates[0].clusterId;
                }
            } catch (error) { /* Silent fallback */ }
        }

        // 2. Fallback: Exact Topic Match
        if (newArticleData.clusterTopic) {
            const existingCluster = await Article.findOne({
                clusterTopic: newArticleData.clusterTopic,
                category: newArticleData.category,
                country: newArticleData.country,
                publishedAt: { $gte: sevenDaysAgo }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) return existingCluster.clusterId;
        }

        // 3. Generate NEW Cluster ID
        try {
            if (redis.isReady()) {
                let newId = await redis.incr('GLOBAL_CLUSTER_ID');
                // Auto-healing: If Redis reset, jump ahead of DB
                if (newId < 100) {
                    const maxDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                    const dbMax = maxDoc?.clusterId || 10000;
                    if (dbMax >= newId) {
                        await redis.getClient()?.set('GLOBAL_CLUSTER_ID', dbMax + 10);
                        newId = dbMax + 10;
                    }
                }
                return newId;
            }
        } catch (err) { /* Redis fail */ }

        return Math.floor(Date.now() / 1000); 
    }
}

export default new ClusteringService();
