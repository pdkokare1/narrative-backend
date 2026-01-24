// services/statsService.ts
import Article from '../models/articleModel';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import SearchLog from '../models/searchLogModel';
import UserStats, { IUserStats } from '../models/userStatsModel'; // Updated Import
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

    // 4. Update User Personalization Vector (Lazy Update)
    async updateUserVector(userId: string) {
        try {
            // A. Throttling Check (From Previous Step)
            if (redisClient.isReady()) {
                const client = redisClient.getClient();
                if (client) {
                    const countKey = `vector_update_count:${userId}`;
                    const count = await client.incr(countKey);
                    
                    if (count % 5 !== 0) {
                        return;
                    }
                }
            }

            // B. Get last 50 viewed article IDs
            const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' })
                .sort({ timestamp: -1 })
                .limit(50) 
                .select('articleId');

            if (recentLogs.length === 0) return;

            const articleIds = recentLogs.map(log => log.articleId);

            // C. Fetch embeddings
            const articles = await Article.find({ 
                _id: { $in: articleIds },
                embedding: { $exists: true, $not: { $size: 0 } }
            }).select('embedding');

            if (articles.length === 0) return;

            // D. Calculate Centroid
            const vectorLength = articles[0].embedding!.length;
            const avgVector = new Array(vectorLength).fill(0);

            articles.forEach(article => {
                const vec = article.embedding!;
                for (let i = 0; i < vectorLength; i++) {
                    avgVector[i] += vec[i];
                }
            });

            for (let i = 0; i < vectorLength; i++) {
                avgVector[i] = avgVector[i] / articles.length;
            }

            // E. Update Profile
            await Profile.updateOne({ userId }, { userEmbedding: avgVector });

        } catch (error) {
            logger.error("❌ Vector Update Failed:", error);
        }
    }

    // 5. Log Search Query
    async logSearch(query: string, resultCount: number) {
        try {
            const normalized = query.toLowerCase().trim();
            if (normalized.length < 2) return;

            // Upsert the log: Increment count, update last searched
            await SearchLog.findOneAndUpdate(
                { normalizedQuery: normalized },
                { 
                    $inc: { count: 1 },
                    $set: { 
                        query: query, // Keep most recent casing
                        lastSearched: new Date(),
                        zeroResults: resultCount === 0,
                        // Simple moving average for result count (approx)
                        resultCountAvg: resultCount 
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error("❌ Search Log Failed:", error);
        }
    }

    // 6. NEW: Apply Recency Decay (The "Time Fade" Protocol)
    // Ensures old interests fade over time so the profile adapts to new habits.
    async applyInterestDecay(userId: string) {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            const lastUpdate = new Date(stats.lastUpdated).getTime();
            const now = Date.now();
            const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

            // Only run decay if at least 24 hours have passed to save DB ops
            if (hoursSinceUpdate < 24) return;

            const daysPassed = Math.floor(hoursSinceUpdate / 24);
            // Decay Factor: 5% decay per day (0.95 ^ days)
            // Example: After 7 days, value is ~70% of original. After 30 days, ~21%.
            const decayFactor = Math.pow(0.95, daysPassed);

            // A. Decay Lean Exposure (Object)
            if (stats.leanExposure) {
                stats.leanExposure.Left = Math.round((stats.leanExposure.Left || 0) * decayFactor);
                stats.leanExposure.Center = Math.round((stats.leanExposure.Center || 0) * decayFactor);
                stats.leanExposure.Right = Math.round((stats.leanExposure.Right || 0) * decayFactor);
            }

            // B. Decay Topic Interest (Map)
            // We use Mongoose Map iteration
            if (stats.topicInterest) {
                stats.topicInterest.forEach((value, key) => {
                    const newValue = Math.round(value * decayFactor);
                    // PRUNING: If interest drops below 10 seconds, remove it to keep doc clean
                    if (newValue < 10) {
                        stats.topicInterest.delete(key);
                    } else {
                        stats.topicInterest.set(key, newValue);
                    }
                });
            }

            // C. Decay Negative Interest (Survivorship Bias Map)
            if (stats.negativeInterest) {
                stats.negativeInterest.forEach((value, key) => {
                    const newValue = Math.round(value * decayFactor);
                    // Prune negatives faster (if < 5 interactions, forget it)
                    if (newValue < 5) {
                        stats.negativeInterest.delete(key);
                    } else {
                        stats.negativeInterest.set(key, newValue);
                    }
                });
            }

            // Mark as modified since we are mutating Maps directly
            stats.lastUpdated = new Date();
            stats.markModified('topicInterest');
            stats.markModified('negativeInterest');
            
            await stats.save();
            // logger.info(`📉 Applied decay to user ${userId} (Factor: ${decayFactor.toFixed(2)})`);

        } catch (error) {
            logger.error("❌ Decay Update Failed:", error);
        }
    }
}

export default new StatsService();
