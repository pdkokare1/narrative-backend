// services/clusteringService.ts
import Article from '../models/articleModel';
import Cache from '../models/cacheModel';
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

        // 3. Generate NEW Cluster ID
        try {
            const farFuture = new Date('2099-12-31T00:00:00.000Z');
            const counterDoc = await Cache.findOneAndUpdate(
                { key: 'GLOBAL_CLUSTER_ID_COUNTER' },
                { $inc: { data: 1 }, $set: { expiresAt: farFuture } },
                { new: true, upsert: true }
            );
            
            let newId = counterDoc?.data;

            if (newId === 1) {
                const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                if (maxIdDoc?.clusterId && maxIdDoc.clusterId > 0) {
                    newId = maxIdDoc.clusterId + 1;
                    await Cache.findOneAndUpdate(
                        { key: 'GLOBAL_CLUSTER_ID_COUNTER' },
                        { $set: { data: newId } }
                    );
                }
            }
            return newId;

        } catch (err) {
            return Math.floor(Date.now() / 1000); 
        }
    }
}

export = new ClusteringService();
