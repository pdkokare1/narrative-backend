// services/clusteringService.js (FINAL v5.1 - Semantic De-Duplication + Inheritance)
const Article = require('../models/articleModel');
const Cache = require('../models/cacheModel');

class ClusteringService {
    
    /**
     * NEW: Checks for a semantic duplicate (92%+ similarity).
     * Returns the existing article with ALL scores so we can inherit them.
     */
    async findSemanticDuplicate(embedding, country) {
        if (!embedding || embedding.length === 0) return null;

        // Look back 24 hours only (duplicates happen in the same news cycle)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        try {
            const candidates = await Article.aggregate([
                {
                    "$vectorSearch": {
                        "index": "vector_index",
                        "path": "embedding",
                        "queryVector": embedding,
                        "numCandidates": 10, 
                        "limit": 1,          
                        "filter": {
                            "country": { "$eq": country } // Strict Country Filter
                        }
                    }
                },
                {
                    "$project": {
                        "clusterId": 1,
                        "headline": 1,
                        "category": 1,
                        // --- IMPORTANT: Fetch data needed for Inheritance ---
                        "politicalLean": 1,
                        "biasScore": 1,
                        "trustScore": 1,
                        "sentiment": 1,
                        "summary": 1,
                        "analysisType": 1,
                        "clusterTopic": 1,
                        // ----------------------------------------------------
                        "score": { "$meta": "vectorSearchScore" } 
                    }
                },
                {
                    "$match": {
                        "publishedAt": { "$gte": oneDayAgo } 
                    }
                }
            ]);

            // Threshold: 0.92 = Content is virtually identical (Syndication)
            if (candidates.length > 0 && candidates[0].score >= 0.92) {
                return candidates[0];
            }
        } catch (error) {
            // Proceed without dedup if vector search fails
            return null;
        }
        
        return null;
    }

    /**
     * Finds the best matching cluster ID for a new article.
     */
    async assignClusterId(newArticleData, embedding) {
        
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching
        if (embedding && embedding.length > 0) {
            try {
                const candidates = await Article.aggregate([
                    {
                        "$vectorSearch": {
                            "index": "vector_index",
                            "path": "embedding",
                            "queryVector": embedding,
                            "numCandidates": 50, 
                            "limit": 1,          
                            "filter": {
                                "country": { "$eq": newArticleData.country } 
                            }
                        }
                    },
                    {
                        "$project": {
                            "clusterId": 1,
                            "score": { "$meta": "vectorSearchScore" } 
                        }
                    },
                    { "$match": { "publishedAt": { "$gte": sevenDaysAgo } } }
                ]);

                if (candidates.length > 0) {
                    // 0.82 is a good "Topical" match (same story, different text)
                    if (candidates[0].score >= 0.82) {
                        return candidates[0].clusterId;
                    }
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
            
            let newId = counterDoc.data;

            // Safety check for first run
            if (newId === 1) {
                const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                if (maxIdDoc?.clusterId > 0) {
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

module.exports = new ClusteringService();
