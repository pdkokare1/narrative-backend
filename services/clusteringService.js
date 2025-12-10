// services/clusteringService.js
const Article = require('../models/articleModel');

class ClusteringService {
    
    /**
     * Finds the best matching cluster ID for a new article.
     * Uses MongoDB Atlas Vector Search for high-performance matching.
     */
    async assignClusterId(newArticleData, embedding) {
        
        // Window: Look at articles from the last 7 days to keep clusters relevant
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching (Database Side)
        // This runs directly on MongoDB Atlas using the 'vector_index' we configured.
        if (embedding && embedding.length > 0) {
            try {
                const candidates = await Article.aggregate([
                    {
                        "$vectorSearch": {
                            "index": "vector_index",
                            "path": "embedding",
                            "queryVector": embedding,
                            "numCandidates": 50, // Look at 50 closest vectors
                            "limit": 1,          // Return only the best match
                            "filter": {
                                "country": { "$eq": newArticleData.country } // Strict Country Filter
                            }
                        }
                    },
                    {
                        "$project": {
                            "clusterId": 1,
                            "headline": 1,
                            "publishedAt": 1,
                            "score": { "$meta": "vectorSearchScore" } // Get the similarity score
                        }
                    },
                    {
                        "$match": {
                            "publishedAt": { "$gte": sevenDaysAgo } // Enforce date window
                        }
                    }
                ]);

                // Check the result
                if (candidates.length > 0) {
                    const bestMatch = candidates[0];
                    const SIMILARITY_THRESHOLD = 0.85; // High threshold for certainty

                    if (bestMatch.score >= SIMILARITY_THRESHOLD) {
                        console.log(`🔗 Smart Cluster Match (DB): "${newArticleData.headline}" matched w/ score ${bestMatch.score.toFixed(2)}`);
                        return bestMatch.clusterId;
                    }
                }
            } catch (error) {
                console.error("⚠️ Vector Search Error (Falling back to fields):", error.message);
                // We don't throw here; we allow it to fall back to Step 2
            }
        }

        // 2. Fallback: 5-Field Legacy Match 
        // Used if vector search fails, index is building, or embedding is missing
        if (newArticleData.clusterTopic) {
            const existingCluster = await Article.findOne({
                clusterTopic: newArticleData.clusterTopic,
                category: newArticleData.category,
                country: newArticleData.country,
                primaryNoun: newArticleData.primaryNoun,
                secondaryNoun: newArticleData.secondaryNoun,
                publishedAt: { $gte: sevenDaysAgo }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) {
                console.log(`🔗 Field Cluster Match: "${newArticleData.headline}" matched via topics.`);
                return existingCluster.clusterId;
            }
        }

        // 3. No match found? Generate a NEW Cluster ID
        const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
        const newClusterId = (maxIdDoc?.clusterId || 0) + 1;
        
        console.log(`✨ New Cluster Created: ID ${newClusterId} for "${newArticleData.headline}"`);
        return newClusterId;
    }
}

module.exports = new ClusteringService();
