// services/statsService.ts
import Article from '../models/articleModel';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

class StatsService {
    
    // 1. Calculate and Cache Trending Topics
    async updateTrendingTopics() {
        try {
            const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            
            // Aggregation: Group by Cluster Topic -> Count -> Sort
            const results = await Article.aggregate([
                { 
                    $match: { 
                        publishedAt: { $gte: twoDaysAgo }, 
                        clusterTopic: { $exists: true, $ne: null } 
                    } 
                },
                { 
                    $group: { 
                        _id: "$clusterTopic", 
                        count: { $sum: 1 },
                        // Get the highest trust score in this cluster as a sample
                        sampleScore: { $max: "$trustScore" } 
                    } 
                },
                { $match: { count: { $gte: 2 } } }, // Only topics with at least 2 articles
                { $sort: { count: -1 } },
                { $limit: 12 }
            ]);

            const topics = results.map(r => ({
                topic: r._id,
                count: r.count,
                score: r.sampleScore || 0
            }));

            // Save to Redis (Expire in 1 hour)
            await redisClient.set('trending_topics_smart', topics, 3600);
            logger.info(`🔥 Trending Topics Updated: ${topics.length} topics found.`);
            
            return topics;

        } catch (error: any) {
            logger.error(`❌ Stats Update Failed: ${error.message}`);
            return [];
        }
    }

    // 2. Get Global Bias Distribution (Cached)
    async getGlobalStats() {
        const CACHE_KEY = 'global_bias_stats';
        const cached = await redisClient.get(CACHE_KEY);
        if (cached) return cached;

        const stats = await Article.aggregate([
            { $group: { _id: "$politicalLean", count: { $sum: 1 } } }
        ]);
        
        // Transform to cleaner object
        const result = stats.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {} as Record<string, number>);

        await redisClient.set(CACHE_KEY, result, 3600 * 4); // Cache for 4 hours
        return result;
    }

    // 3. Increment Counter (FIX for Pipeline)
    async increment(metric: string) {
        try {
            if (!redisClient.isReady()) return;
            
            const client = redisClient.getClient();
            if (!client) return;

            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const key = `stats:${today}:${metric}`;
            
            // Atomic increment
            await client.incr(key);
            // Ensure it cleans up after 7 days
            await client.expire(key, 60 * 60 * 24 * 7);

        } catch (error) {
            // Silent fail is acceptable for stats to avoid breaking the main flow
            // console.warn('Stats increment failed', error);
        }
    }
}

export default new StatsService();
