// services/clusteringService.ts
import Article from '../models/articleModel';
import redis from '../utils/redisClient';
import { IArticle } from '../types';

// --- HELPER: Levenshtein Distance for String Similarity ---
function getStringSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const track = Array(s2.length + 1).fill(null).map(() =>
        Array(s1.length + 1).fill(null));

    for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

    for (let j = 1; j <= s2.length; j += 1) {
        for (let i = 1; i <= s1.length; i += 1) {
            const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
                track[j][i - 1] + 1, // deletion
                track[j - 1][i] + 1, // insertion
                track[j - 1][i - 1] + indicator // substitution
            );
        }
    }
    const distance = track[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - (distance / maxLength);
}

class ClusteringService {

    // --- NEW: Stage 1 (Fast Fuzzy Match) ---
    // Uses MongoDB Text Search to narrow down candidates, then uses Levenshtein for precision.
    async findSimilarHeadline(headline: string): Promise<IArticle | null> {
        if (!headline || headline.length < 5) return null;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        try {
            // OPTIMIZATION: Use MongoDB Text Search First
            // Instead of scanning ALL articles, we only scan ones with matching words.
            const candidates = await Article.find({ 
                $text: { $search: headline }, // Requires text index on headline
                publishedAt: { $gte: oneDayAgo } 
            })
            .limit(20) // Only compare against the top 20 relevant text matches
            .select('headline summary category politicalLean biasScore trustScore sentiment analysisType clusterTopic clusterId createdAt')
            .lean();

            // Find best match in memory among the top candidates
            let bestMatch: any = null;
            let bestScore = 0;

            for (const candidate of candidates) {
                const score = getStringSimilarity(headline, candidate.headline);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = candidate;
                }
            }

            // SAFETY THRESHOLD: 0.80 (80%)
            if (bestScore > 0.80 && bestMatch) {
                return bestMatch as IArticle;
            }

        } catch (error) { 
            // Fallback: If text search fails (e.g. index missing), return null to be safe
            // System will just generate a fresh analysis instead of crashing.
        }

        return null;
    }

    // --- Stage 2: Vector Search (Original) ---
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
                        "clusterId": 1, "headline": 1, "category": 1,
                        "politicalLean": 1, "biasScore": 1, "trustScore": 1,
                        "sentiment": 1, "summary": 1, "analysisType": 1, "clusterTopic": 1,
                        "score": { "$meta": "vectorSearchScore" } 
                    }
                },
                { "$match": { "publishedAt": { "$gte": oneDayAgo } } }
            ];

            const candidates = await Article.aggregate(pipeline);

            // High confidence for Semantic Match (92%)
            if (candidates.length > 0 && candidates[0].score >= 0.92) {
                return candidates[0] as IArticle;
            }
        } catch (error) { /* Ignore */ }
        
        return null;
    }

    async assignClusterId(newArticleData: Partial<IArticle>, embedding: number[] | undefined): Promise<number> {
        
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching for Cluster Assignment
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

        // 2. Fallback: Field Match 
        if (newArticleData.clusterTopic) {
            const existingCluster = await Article.findOne({
                clusterTopic: newArticleData.clusterTopic,
                category: newArticleData.category,
                country: newArticleData.country,
                publishedAt: { $gte: sevenDaysAgo }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) {
                return existingCluster.clusterId;
            }
        }

        // 3. Generate NEW Cluster ID (Optimized via Redis)
        try {
            // @ts-ignore
            if (redis.isReady()) {
                let newId = await redis.incr('GLOBAL_CLUSTER_ID');
                
                // Sync check if Redis was reset
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
                return newId;
            } else {
                return Math.floor(Date.now() / 1000); 
            }
        } catch (err) {
            return Math.floor(Date.now() / 1000); 
        }
    }
}

export default new ClusteringService();
