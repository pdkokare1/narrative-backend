// services/clusteringService.js (FINAL v4.2 - Atomic Counters)
const Article = require('../models/articleModel');
const Cache = require('../models/cacheModel');

class ClusteringService {
    
    /**
     * Finds the best matching cluster ID for a new article.
     * Uses Vector Search -> Field Match -> Atomic Counter Fallback.
     */
    async assignClusterId(newArticleData, embedding) {
        
        // Window: Look at articles from the last 7 days to keep clusters relevant
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching (Database Side)
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
                                "country": { "$eq": newArticleData.country } // Strict Country Filter
                            }
                        }
                    },
                    {
                        "$project": {
                            "clusterId": 1,
                            "headline": 1,
                            "score": { "$meta": "vectorSearchScore" } 
                        }
                    },
                    {
                        "$match": {
                            "publishedAt": { "$gte": sevenDaysAgo } 
                        }
                    }
                ]);

                // Check result
                if (candidates.length > 0) {
                    const bestMatch = candidates[0];
                    // Threshold: 0.85 is a strong match
                    if (bestMatch.score >= 0.85) {
                        console.log(`🔗 Smart Cluster Match: "${newArticleData.headline.substring(0,20)}..." (Score: ${bestMatch.score.toFixed(2)})`);
                        return bestMatch.clusterId;
                    }
                }
            } catch (error) {
                // Vector search might fail during index builds; silent fallback to Step 2
            }
        }

        // 2. Fallback: 5-Field Legacy Match 
        if (newArticleData.clusterTopic) {
            const existingCluster = await Article.findOne({
                clusterTopic: newArticleData.clusterTopic,
                category: newArticleData.category,
                country: newArticleData.country,
                publishedAt: { $gte: sevenDaysAgo }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) {
                console.log(`🔗 Field Cluster Match: "${newArticleData.headline.substring(0,20)}..."`);
                return existingCluster.clusterId;
            }
        }

        // 3. Generate NEW Cluster ID (Atomic & Thread-Safe)
        // We use the Cache collection to store a persistent counter.
        try {
            // Set expiry to year 2099 so this counter never gets deleted by the TTL index
            const farFuture = new Date('2099-12-31T00:00:00.000Z');
            
            const counterDoc = await Cache.findOneAndUpdate(
                { key: 'GLOBAL_CLUSTER_ID_COUNTER' },
                { 
                    $inc: { data: 1 }, // Atomic increment
                    $set: { expiresAt: farFuture }
                },
                { new: true, upsert: true }
            );
            
            let newId = counterDoc.data;

            // SAFETY CHECK: If this is the first time running (e.g. data=1), 
            // make sure we don't clash with existing legacy article IDs.
            if (newId === 1) {
                const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select('clusterId').lean();
                const currentMax = maxIdDoc?.clusterId || 0;
                
                if (currentMax > 0) {
                    // Jump ahead of the old IDs
                    newId = currentMax + 1;
                    // Sync the counter so next time is correct
                    await Cache.findOneAndUpdate(
                        { key: 'GLOBAL_CLUSTER_ID_COUNTER' },
                        { $set: { data: newId } }
                    );
                }
            }

            console.log(`✨ New Cluster Created: ID ${newId}`);
            return newId;

        } catch (err) {
            console.error("Cluster Counter Error:", err);
            // Ultimate fallback if DB fails: Use timestamp (Unique enough)
            return Math.floor(Date.now() / 1000); 
        }
    }
}

module.exports = new ClusteringService();
