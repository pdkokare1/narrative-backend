// services/clusteringService.js
const Article = require('../models/articleModel');

// Calculate Cosine Similarity between two vectors
// Returns a value between -1 and 1. (1 means identical direction/meaning)
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class ClusteringService {
    
    /**
     * Finds the best matching cluster ID for a new article.
     * Uses a Hybrid Approach: 
     * 1. Strong "Smart Vector" match (Semantic Similarity > 0.85)
     * 2. Fallback to "5-Field" match (Topic + Category + Country + Nouns)
     */
    async assignClusterId(newArticleData, embedding) {
        
        // Window: Look at articles from the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // 1. Try Vector Matching (The "AI Brain")
        if (embedding && embedding.length > 0) {
            // Fetch recent articles that HAVE embeddings
            // Optimization: We only fetch the specific fields we need to compare
            const candidates = await Article.find({
                publishedAt: { $gte: sevenDaysAgo },
                embedding: { $exists: true, $ne: [] },
                country: newArticleData.country // Must match country
            }).select('clusterId embedding headline').lean();

            let bestMatchId = null;
            let highestScore = 0;
            const SIMILARITY_THRESHOLD = 0.85; // High threshold for certainty

            for (const candidate of candidates) {
                const score = cosineSimilarity(embedding, candidate.embedding);
                if (score > highestScore) {
                    highestScore = score;
                    bestMatchId = candidate.clusterId;
                }
            }

            if (highestScore >= SIMILARITY_THRESHOLD && bestMatchId) {
                console.log(`🔗 Smart Cluster Match: "${newArticleData.headline}" matched w/ score ${highestScore.toFixed(2)}`);
                return bestMatchId;
            }
        }

        // 2. Fallback: 5-Field Legacy Match (If vector fails or no embedding)
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
