// services/clusteringService.ts
import Article from '../models/articleModel';
import redis from '../utils/redisClient';
import { IArticle } from '../types';

class ClusteringService {
    
    async findSemanticDuplicate(embedding: number[] | undefined, country: string): Promise<IArticle | null> {
        if (!embedding || embedding.length === 0) return null;

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        try {
            // FIX: We cast the pipeline to 'any' because TypeScript doesn't know $vectorSearch yet
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

            if (candidates.length > 0 && candidates[0].score >= 0.92) {
                return candidates[0] as IArticle;
            }
        } catch (error) { /* Ignore */ }
        
        return null;
    }

    async assignClusterId(newArticleData: Partial<IArticle>, embedding: number[] | undefined): Promise<number> {
        
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching
        if (embedding && embedding.length > 0) {
            try {
                // FIX: Cast pipeline to 'any'
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
                // Increment atomic counter in Redis
                let newId = await redis.incr('GLOBAL_CLUSTER_ID');
                
                // Safety: If Redis was just flushed/reset, newId might be 1, but DB has higher IDs.
                // We assume ID > 10000 means it's initialized. If small, we sync from DB.
                if (newId < 100) {
                    const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                    const dbMax = maxIdDoc?.clusterId || 10000;
                    
                    // If DB is ahead, reset Redis to DB value + 1
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
                // Fallback if Redis is down: Timestamp based
                return Math.floor(Date.now() / 1000); 
            }
        } catch (err) {
            return Math.floor(Date.now() / 1000); 
        }
    }
}

export = new ClusteringService();
