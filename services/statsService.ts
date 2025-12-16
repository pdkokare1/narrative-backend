// services/statsService.ts
import Article from '../models/articleModel';
import redis from '../utils/redisClient';
import logger from '../utils/logger';

class StatsService {
    
    /**
     * Calculates trending topics based on article clusters from the last 48 hours.
     * Caches the result in Redis for 1 hour.
     */
    async updateTrendingTopics() {
        logger.info('📈 Updating Trending Topics Cache...');
        try {
            const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            
            const results = await Article.aggregate([
                // 1. Filter: Recent articles that belong to a cluster
                { 
                    $match: { 
                        publishedAt: { $gte: twoDaysAgo }, 
                        clusterTopic: { $exists: true, $ne: null } 
                    } 
                },
                // 2. Group: Count articles per topic and get the highest trust score in that group
                { 
                    $group: { 
                        _id: "$clusterTopic", 
                        count: { $sum: 1 }, 
                        sampleScore: { $max: "$trustScore" } 
                    } 
                },
                // 3. Threshold: Only topics with at least 3 articles
                { $match: { count: { $gte: 3 } } }, 
                // 4. Sort: Most popular first
                { $sort: { count: -1 } },
                // 5. Limit: Top 10
                { $limit: 10 }
            ]);
            
            const topics = results.map(r => ({ 
                topic: r._id, 
                count: r.count, 
                score: r.sampleScore 
            }));
            
            // Save to Redis (Expires in 1 hour)
            if (redis.isReady()) {
                await redis.set('trending_topics_smart', topics, 3600); 
                logger.info(`✅ Trending Topics Updated (${topics.length} topics)`);
            }
        } catch (err: any) {
            logger.error(`❌ Trending Calc Failed: ${err.message}`);
        }
    }
}

export default new StatsService();
