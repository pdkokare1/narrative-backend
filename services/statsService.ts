// services/statsService.ts
import Article from '../models/articleModel';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import SearchLog from '../models/searchLogModel';
import UserStats, { IUserStats } from '../models/userStatsModel'; 
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

class StatsService {
    
    // --- MAIN PIPELINE: Interaction Processing ---
    async processInteraction(userId: string, interaction: any) {
        try {
            if (!userId || !interaction) return;

            // 1. Handle Impressions (Passive Bias Tracking)
            if (interaction.contentType === 'impression') {
                await this.processImpression(userId, interaction);
                return;
            }

            // 2. Filter for Content Interactions only (Updated to include Audio)
            if (interaction.contentType !== 'article' && 
                interaction.contentType !== 'narrative' && 
                interaction.contentType !== 'audio_action') {
                return;
            }

            const stats = await UserStats.findOne({ userId });
            if (!stats) return; // Safety check

            const duration = interaction.duration || 0; // seconds
            const scrollDepth = interaction.scrollDepth || 0; // percentage
            const wordCount = interaction.wordCount || 0;

            // 3. Update Global Time
            stats.totalTimeSpent = (stats.totalTimeSpent || 0) + duration;

            // 4. "True Read" Validation
            let isTrueRead = false;
            
            // Logic A: Standard Text Reading
            if (interaction.contentType === 'article' || interaction.contentType === 'narrative') {
                // Avg reading speed ~250 wpm. Threshold 50% of expected time.
                if (wordCount > 50 && duration > 10) {
                    const expectedTimeSeconds = (wordCount / 250) * 60;
                    const minimumThreshold = expectedTimeSeconds * 0.5; 

                    if (duration >= minimumThreshold && scrollDepth > 50) {
                        isTrueRead = true;
                    }
                }
            }

            // Logic B: Audio Completion
            if (interaction.contentType === 'audio_action' && interaction.audioAction === 'complete') {
                isTrueRead = true;
                logger.info(`🎧 Audio Completion Verified for User ${userId}`);
            }

            if (isTrueRead) {
                stats.articlesReadCount = (stats.articlesReadCount || 0) + 1;
                // Log the read type for clarity
                const readType = interaction.contentType === 'audio_action' ? 'Audio Listen' : 'Text Read';
                logger.info(`📖 True Read Recorded (${readType}): User ${userId} | Time: ${duration}s | Depth: ${scrollDepth}%`);
                
                // NEW: Check for Content Fatigue (Burnout Protection)
                await this.checkContentFatigue(userId, interaction.text);
            }

            // 5. Update Average Attention Span
            if (stats.articlesReadCount > 0) {
                stats.averageAttentionSpan = Math.round(stats.totalTimeSpent / stats.articlesReadCount);
            }

            stats.lastUpdated = new Date();
            
            // 6. HABIT & STREAK TRACKING (The "Daily Ritual")
            await this.checkHabitProgress(userId, stats, duration, isTrueRead);

            await stats.save();

            // 7. (Optional) Trigger Vector Update if True Read
            if (isTrueRead) {
                this.updateUserVector(userId);
            }

        } catch (error) {
            logger.error(`❌ Error processing interaction for user ${userId}:`, error);
        }
    }

    // --- NEW: Impression Processing (Survivorship Bias) ---
    async processImpression(userId: string, interaction: any) {
        try {
            // text format expected: "article:Politics" or "narrative:Technology"
            const info = interaction.text || '';
            const [type, topic] = info.split(':');

            if (!topic || topic === 'undefined') return;

            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            // Init Maps if missing
            if (!stats.topicImpressions) stats.topicImpressions = new Map();
            if (!stats.negativeInterest) stats.negativeInterest = new Map();
            if (!stats.topicInterest) stats.topicInterest = new Map();

            // 1. Increment Impression Count
            const currentImpressions = (stats.topicImpressions.get(topic) || 0) + 1;
            stats.topicImpressions.set(topic, currentImpressions);

            // 2. Check for "Negative Interest" (High Exposure, Low Clicks)
            // Logic: If user has seen topic > 5 times, check Click/Impression ratio
            if (currentImpressions >= 5) {
                const clicks = stats.topicInterest.get(topic) || 0;
                const ratio = clicks / currentImpressions;

                // If CTR is below 10%, consider it "Negative Interest"
                if (ratio < 0.1) {
                    const negativeScore = (stats.negativeInterest.get(topic) || 0) + 1;
                    stats.negativeInterest.set(topic, negativeScore);
                } else {
                    // If they start clicking, remove from negative interest
                    if (stats.negativeInterest.has(topic)) {
                        stats.negativeInterest.delete(topic);
                    }
                }
            }

            stats.markModified('topicImpressions');
            stats.markModified('negativeInterest');
            await stats.save();

        } catch (error) {
            // Fail silently for impressions to reduce noise
        }
    }

    // --- NEW: Content Fatigue Detection ---
    async checkContentFatigue(userId: string, topicString: string) {
        try {
            // Expect topicString format "article:Politics" or just "Politics"
            if (!topicString || !redisClient.isReady()) return;
            
            const topic = topicString.includes(':') ? topicString.split(':')[1] : topicString;
            if (!topic || topic === 'undefined') return;

            const client = redisClient.getClient();
            if (!client) return;

            const key = `fatigue_monitor:${userId}`;
            
            // 1. Push topic to recent list
            await client.lPush(key, topic);
            // 2. Keep only last 10 items
            await client.lTrim(key, 0, 9);
            
            // 3. Check frequency
            const recentTopics = await client.lRange(key, 0, -1);
            const count = recentTopics.filter(t => t === topic).length;

            // 4. Trigger Fatigue if > 5 reads of same topic recently
            if (count > 5) {
                logger.info(`💤 Content Fatigue Detected: User ${userId} is tired of ${topic}`);
                // Set a temporary block/suppression key for 2 hours (7200 seconds)
                await client.setEx(`fatigue_block:${userId}:${topic}`, 7200, 'true');
            }

        } catch (error) {
            logger.warn('Fatigue check failed', error);
        }
    }

    // --- NEW: Habit & Streak Engine ---
    async checkHabitProgress(userId: string, stats: IUserStats, duration: number, isTrueRead: boolean) {
        try {
            const now = new Date();
            
            // 1. Check for "New Day" Reset
            // Compare dates (YYYY-MM-DD)
            const lastDate = stats.dailyStats?.date ? new Date(stats.dailyStats.date) : new Date(0);
            const isSameDay = lastDate.toDateString() === now.toDateString();

            if (!isSameDay) {
                // It's a new day! Reset counters.
                stats.dailyStats = {
                    date: now,
                    timeSpent: 0,
                    articlesRead: 0,
                    goalsMet: false
                };
            }

            // 2. Update Daily Counters
            stats.dailyStats.timeSpent += duration;
            if (isTrueRead) stats.dailyStats.articlesRead += 1;

            // 3. Load Profile to check Goals & Streaks
            // We only need to check streaks if the goal hasn't been met yet today
            if (!stats.dailyStats.goalsMet) {
                const profile = await Profile.findOne({ userId });
                if (profile && profile.habits && profile.habits.length > 0) {
                    
                    // Find the primary daily habit (defaulting to 15 mins if not found)
                    const dailyHabit = profile.habits.find(h => h.type === 'daily_minutes');
                    const targetSeconds = dailyHabit ? dailyHabit.target * 60 : 15 * 60; // default 15 mins

                    // 4. Did we just cross the finish line?
                    if (stats.dailyStats.timeSpent >= targetSeconds) {
                        stats.dailyStats.goalsMet = true;
                        
                        // --- STREAK LOGIC ---
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        
                        const lastActive = profile.lastActiveDate ? new Date(profile.lastActiveDate) : new Date(0);
                        const isConsecutive = lastActive.toDateString() === yesterday.toDateString();
                        const isToday = lastActive.toDateString() === now.toDateString();

                        if (!isToday) {
                            if (isConsecutive) {
                                // Perfect streak
                                profile.currentStreak += 1;
                            } else {
                                // Streak Broken? Check Freezes.
                                const daysGap = Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24));
                                
                                if (daysGap > 1 && profile.streakFreezes > 0) {
                                    // Saved by the freeze!
                                    profile.streakFreezes -= 1;
                                    // Streak continues (phantom increment logic or just keep it?)
                                    // We keep the number but don't increment, or increment?
                                    // Standard logic: You used a freeze, you keep the streak alive.
                                    profile.currentStreak += 1;
                                    logger.info(`❄️ Streak Saved by Freeze for User ${userId}`);
                                } else if (daysGap > 1) {
                                    // Sorry, back to 1
                                    profile.currentStreak = 1;
                                } else {
                                    // First day ever or restart
                                    profile.currentStreak = 1;
                                }
                            }
                            profile.lastActiveDate = now;
                            await profile.save();
                            logger.info(`🔥 Streak Updated for User ${userId}: ${profile.currentStreak}`);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error(`Habit Check Error:`, error);
        }
    }

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
            // Silent fail is acceptable for stats
        }
    }

    // 4. Update User Personalization Vector (Lazy Update)
    async updateUserVector(userId: string) {
        try {
            // A. Throttling Check
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

            await SearchLog.findOneAndUpdate(
                { normalizedQuery: normalized },
                { 
                    $inc: { count: 1 },
                    $set: { 
                        query: query,
                        lastSearched: new Date(),
                        zeroResults: resultCount === 0,
                        resultCountAvg: resultCount 
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error("❌ Search Log Failed:", error);
        }
    }

    // 6. Apply Recency Decay (The "Time Fade" Protocol)
    async applyInterestDecay(userId: string) {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            const lastUpdate = new Date(stats.lastUpdated).getTime();
            const now = Date.now();
            const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

            // Only run decay if at least 24 hours have passed
            if (hoursSinceUpdate < 24) return;

            const daysPassed = Math.floor(hoursSinceUpdate / 24);
            const decayFactor = Math.pow(0.95, daysPassed);

            // A. Decay Lean Exposure
            if (stats.leanExposure) {
                stats.leanExposure.Left = Math.round((stats.leanExposure.Left || 0) * decayFactor);
                stats.leanExposure.Center = Math.round((stats.leanExposure.Center || 0) * decayFactor);
                stats.leanExposure.Right = Math.round((stats.leanExposure.Right || 0) * decayFactor);
            }

            // B. Decay Topic Interest
            if (stats.topicInterest) {
                stats.topicInterest.forEach((value, key) => {
                    const newValue = Math.round(value * decayFactor);
                    if (newValue < 10) {
                        stats.topicInterest.delete(key);
                    } else {
                        stats.topicInterest.set(key, newValue);
                    }
                });
            }

            // C. Decay Negative Interest
            if (stats.negativeInterest) {
                stats.negativeInterest.forEach((value, key) => {
                    const newValue = Math.round(value * decayFactor);
                    if (newValue < 5) {
                        stats.negativeInterest.delete(key);
                    } else {
                        stats.negativeInterest.set(key, newValue);
                    }
                });
            }

            stats.lastUpdated = new Date();
            stats.markModified('topicInterest');
            stats.markModified('negativeInterest');
            
            await stats.save();

        } catch (error) {
            logger.error("❌ Decay Update Failed:", error);
        }
    }
}

export default new StatsService();
