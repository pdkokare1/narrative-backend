// services/statsService.ts
import Article from '../models/articleModel';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import SearchLog from '../models/searchLogModel';
import UserStats, { IUserStats } from '../models/userStatsModel'; 
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import gamificationService from './gamificationService';

class StatsService {
    
    // --- MAIN PIPELINE: Interaction Processing ---
    async processInteraction(userId: string, interaction: any, timezone?: string) {
        try {
            if (!userId || !interaction) return;

            // 1. Handle Impressions (Passive Bias Tracking)
            if (interaction.contentType === 'impression') {
                await this.processImpression(userId, interaction);
                return;
            }

            // 2. Filter for Content Interactions
            if (interaction.contentType !== 'article' && 
                interaction.contentType !== 'narrative' && 
                interaction.contentType !== 'audio_action') {
                return;
            }

            const stats = await UserStats.findOne({ userId });
            if (!stats) return; 

            // NEW: Update Timezone
            if (timezone) stats.lastTimezone = timezone;

            const duration = interaction.duration || 0; // seconds
            const scrollDepth = interaction.scrollDepth || 0; // percentage
            const wordCount = interaction.wordCount || 0;
            const focusScore = interaction.focusScore || 100; // New: Default to 100
            
            // NEW: Update Global Focus Score (Moving Average)
            // Weight recent interaction 10%, historical 90%
            stats.focusScoreAvg = Math.round(((stats.focusScoreAvg || 100) * 0.9) + (focusScore * 0.1));

            // NEW: Save Stop Point (Resume Reading)
            if (interaction.scrollPosition && interaction.contentId) {
                if (!stats.readingProgress) stats.readingProgress = new Map();
                if (interaction.scrollPosition > 100) {
                    stats.readingProgress.set(interaction.contentId, interaction.scrollPosition);
                }
            }

            // 3. Update Global Time
            stats.totalTimeSpent = (stats.totalTimeSpent || 0) + duration;

            // 4. "True Read" Validation (Enhanced)
            let isTrueRead = false;
            const wpm = duration > 0 ? wordCount / (duration / 60) : 9999;
            
            // Logic A: Standard Text Reading
            if (interaction.contentType === 'article' || interaction.contentType === 'narrative') {

                // STRICT CHECK: Must be > 30s, > 75% scroll, reasonable speed
                // NEW: Added Focus Score check. If they tabbed away constantly (score < 50), it's not a true read.
                if (wordCount > 100 && scrollDepth > 75 && duration > 30 && wpm < 600 && focusScore > 40) {
                    isTrueRead = true;
                }

                // NEW: Skimmer Detection
                // If they scrolled deep (>50%) but read very fast (>600 WPM)
                if (scrollDepth > 50 && wpm > 600) {
                    stats.readingStyle = 'skimmer';
                }
                // If they read slowly (>60s) and deeply
                else if (duration > 60 && scrollDepth > 80 && wpm < 400) {
                    stats.readingStyle = 'deep_reader';
                }
            }

            // Logic B: Audio Completion
            if (interaction.contentType === 'audio_action' && interaction.audioAction === 'complete') {
                isTrueRead = true;
                logger.info(`🎧 Audio Completion Verified for User ${userId}`);
            }

            if (isTrueRead) {
                stats.articlesReadCount = (stats.articlesReadCount || 0) + 1;
                const readType = interaction.contentType === 'audio_action' ? 'Audio Listen' : 'Text Read';
                logger.info(`📖 True Read Recorded (${readType}): User ${userId} | Time: ${duration}s | Focus: ${focusScore}`);
                
                await this.checkContentFatigue(userId, interaction.text);
            }

            // 5. Update Average Attention Span
            if (stats.articlesReadCount > 0) {
                stats.averageAttentionSpan = Math.round(stats.totalTimeSpent / stats.articlesReadCount);
            }

            stats.lastUpdated = new Date();
            
            // 6. HABIT & STREAK TRACKING (The "Daily Ritual")
            await this.checkHabitProgress(userId, stats, duration, isTrueRead, timezone);

            // 7. Trigger Vector Update
            if (isTrueRead) {
                this.updateUserVector(userId);
            }

            // 8. Update Topic Interests AND Perspective Score
            if (interaction.contentId && (interaction.contentType === 'article' || interaction.contentType === 'narrative')) {
                 await this.updateInterests(stats, interaction.contentId, duration, timezone);
            }

            await stats.save();

        } catch (error) {
            logger.error(`❌ Error processing interaction for user ${userId}:`, error);
        }
    }

    // --- NEW: Impression Processing ---
    async processImpression(userId: string, interaction: any) {
        try {
            const info = interaction.text || '';
            const [type, topic] = info.split(':');

            if (!topic || topic === 'undefined') return;

            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            if (!stats.topicImpressions) stats.topicImpressions = new Map();
            if (!stats.negativeInterest) stats.negativeInterest = new Map();
            if (!stats.topicInterest) stats.topicInterest = new Map();

            const currentImpressions = (stats.topicImpressions.get(topic) || 0) + 1;
            stats.topicImpressions.set(topic, currentImpressions);

            // Negative Interest Logic
            if (currentImpressions >= 5) {
                const clicks = stats.topicInterest.get(topic) || 0;
                const ratio = clicks / currentImpressions;

                if (ratio < 0.1) {
                    const negativeScore = (stats.negativeInterest.get(topic) || 0) + 1;
                    stats.negativeInterest.set(topic, negativeScore);
                } else {
                    if (stats.negativeInterest.has(topic)) {
                        stats.negativeInterest.delete(topic);
                    }
                }
            }

            stats.markModified('topicImpressions');
            stats.markModified('negativeInterest');
            await stats.save();

        } catch (error) {
            // Fail silently
        }
    }

    // --- NEW: Content Fatigue Detection ---
    async checkContentFatigue(userId: string, topicString: string) {
        try {
            if (!topicString || !redisClient.isReady()) return;
            
            const topic = topicString.includes(':') ? topicString.split(':')[1] : topicString;
            if (!topic || topic === 'undefined') return;

            const client = redisClient.getClient();
            if (!client) return;

            const key = `fatigue_monitor:${userId}`;
            await client.lPush(key, topic);
            await client.lTrim(key, 0, 9);
            
            const recentTopics = await client.lRange(key, 0, -1);
            const count = recentTopics.filter(t => t === topic).length;

            if (count > 5) {
                logger.info(`💤 Content Fatigue Detected: User ${userId} is tired of ${topic}`);
                await client.setEx(`fatigue_block:${userId}:${topic}`, 7200, 'true');
            }

        } catch (error) {
            logger.warn('Fatigue check failed', error);
        }
    }

    // --- NEW: Habit & Streak Engine with FREEZE Protocol ---
    async checkHabitProgress(userId: string, stats: any, duration: number, isTrueRead: boolean, timezone?: string) {
        try {
            const now = new Date();
            const tz = timezone || 'UTC';

            const getDayString = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: tz });
            const todayStr = getDayString(now);
            
            // Handle new user case
            const lastActiveDate = stats.lastActiveDate ? new Date(stats.lastActiveDate) : new Date(0);
            const lastActiveStr = getDayString(lastActiveDate);

            // If it's a NEW DAY (not the same as last active)
            if (todayStr !== lastActiveStr) {
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayStr = getDayString(yesterday);

                // Scenario 1: Consecutive Day (Streak continues)
                if (lastActiveStr === yesterdayStr) {
                    stats.currentStreak = (stats.currentStreak || 0) + 1;
                    
                    // Reward: Every 7 days, earn a freeze (Max 3)
                    if (stats.currentStreak % 7 === 0 && (stats.streakFreezes || 0) < 3) {
                        stats.streakFreezes = (stats.streakFreezes || 0) + 1;
                    }
                } 
                // Scenario 2: Missed Day (Check for Freeze)
                else {
                    const daysMissed = Math.floor((now.getTime() - lastActiveDate.getTime()) / (1000 * 60 * 60 * 24));
                    
                    // Only use freeze if missed just 1-2 days (don't freeze for a month of absence)
                    if (daysMissed <= 2 && (stats.streakFreezes || 0) > 0) {
                        stats.streakFreezes -= 1;
                        stats.lastFreezeUsed = now;
                        logger.info(`❄️ Streak Freeze Used for User ${userId}`);
                        // Do NOT reset streak.
                    } else {
                        // Reset Streak
                        stats.currentStreak = 1; 
                    }
                }

                if (stats.currentStreak > (stats.longestStreak || 0)) {
                    stats.longestStreak = stats.currentStreak;
                }
            }
            stats.lastActiveDate = now;

            // HISTORY LOGGING
            if (!stats.recentDailyHistory) stats.recentDailyHistory = [];
            
            let dailyEntry = stats.recentDailyHistory.find((d: any) => d.date === todayStr);

            if (!dailyEntry) {
                dailyEntry = { date: todayStr, timeSpent: 0, articlesRead: 0, goalsMet: false };
                if (stats.recentDailyHistory.length >= 30) stats.recentDailyHistory.shift();
                stats.recentDailyHistory.push(dailyEntry);
            }

            dailyEntry.timeSpent += duration;
            if (isTrueRead) dailyEntry.articlesRead += 1;

            stats.dailyStats = {
                date: now,
                timeSpent: dailyEntry.timeSpent,
                articlesRead: dailyEntry.articlesRead,
                goalsMet: dailyEntry.goalsMet 
            };

            // CHECK GOALS
            if (!dailyEntry.goalsMet) {
                const profile = await Profile.findOne({ userId });
                const dailyHabit = profile?.habits?.find((h:any) => h.type === 'daily_minutes');
                const targetSeconds = dailyHabit ? dailyHabit.target * 60 : 15 * 60; 

                if (dailyEntry.timeSpent >= targetSeconds) {
                    dailyEntry.goalsMet = true;
                    stats.dailyStats.goalsMet = true;
                    await gamificationService.updateStreak(userId, timezone);
                }
            }
        } catch (error) {
            logger.error(`Habit Check Error:`, error);
        }
    }

    // --- HELPER: Update Interests & Diversity ---
    private async updateInterests(stats: any, articleId: string, duration: number, timezone?: string) {
        try {
            const article = await Article.findOne({ _id: articleId }).select('topics detectedBias category');
            if (!article) return;

            const interestWeight = Math.min(duration, 120); 

            // 1. Update Topic Interest
            if (article.topics && Array.isArray(article.topics)) {
                if (!stats.topicInterest) stats.topicInterest = new Map();
                article.topics.forEach(topic => {
                    const current = stats.topicInterest.get(topic) || 0;
                    stats.topicInterest.set(topic, current + interestWeight);
                });
            }

            // 2. Update Political Lean & Diversity Score
            if (article.detectedBias !== undefined) {
                let bucket = 'Center';
                if (article.detectedBias <= -0.3) bucket = 'Left';
                if (article.detectedBias >= 0.3) bucket = 'Right';
                
                // Update Exposure Count
                if (!stats.leanExposure) stats.leanExposure = { Left: 0, Center: 0, Right: 0 };
                stats.leanExposure[bucket] = (stats.leanExposure[bucket] || 0) + interestWeight;

                // --- NEW: Time-of-Day Contextualization ---
                // Calculate Hour in User's Timezone
                let hour = new Date().getHours(); // Default to Server Time
                if (timezone) {
                    try {
                        const dateStr = new Date().toLocaleString("en-US", { timeZone: timezone, hour: 'numeric', hour12: false });
                        hour = parseInt(dateStr, 10);
                    } catch (e) { /* Fallback to server time */ }
                }

                // Morning: Before 12:00
                if (hour < 12) {
                    if (!stats.leanExposureMorning) stats.leanExposureMorning = { Left: 0, Center: 0, Right: 0 };
                    stats.leanExposureMorning[bucket] = (stats.leanExposureMorning[bucket] || 0) + interestWeight;
                }
                // Evening: After 17:00 (5 PM)
                else if (hour >= 17) {
                    if (!stats.leanExposureEvening) stats.leanExposureEvening = { Left: 0, Center: 0, Right: 0 };
                    stats.leanExposureEvening[bucket] = (stats.leanExposureEvening[bucket] || 0) + interestWeight;
                }

                // --- NEW: Calculate Diversity Score (Echo Chamber Breaker) ---
                if (!stats.lastLeanSequence) stats.lastLeanSequence = [];
                
                // Add current read to sequence (Keep last 10)
                stats.lastLeanSequence.push(bucket);
                if (stats.lastLeanSequence.length > 10) {
                    stats.lastLeanSequence.shift();
                }

                // Analyze the Mix
                const sequence = stats.lastLeanSequence;
                const leftCount = sequence.filter(x => x === 'Left').length;
                const rightCount = sequence.filter(x => x === 'Right').length;
                const centerCount = sequence.filter(x => x === 'Center').length;
                const total = sequence.length;

                // Base Score: 50 (Neutral)
                let diversity = 50;

                // If they have meaningful history (>3 items)
                if (total > 3) {
                    // Perfect Balance: 100
                    if (leftCount > 0 && rightCount > 0 && centerCount > 0) {
                        diversity = 100;
                    } 
                    // Healthy Mix (Left+Right, Left+Center, Right+Center): 75
                    else if ((leftCount > 0 && rightCount > 0) || (leftCount > 0 && centerCount > 0) || (rightCount > 0 && centerCount > 0)) {
                        diversity = 75;
                    }
                    // Echo Chamber (Only Left or Only Right): 25
                    else if ((leftCount === total) || (rightCount === total)) {
                        diversity = 25;
                    }
                    // Only Center (Safe but not diverse): 60
                    else {
                        diversity = 60;
                    }
                }

                stats.diversityScore = diversity;
            }
        } catch (e) { 
            logger.warn('Error in updateInterests:', e);
        }
    }

    // 1. Calculate and Cache Trending Topics
    async updateTrendingTopics() {
        try {
            const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            
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
                        sampleScore: { $max: "$trustScore" } 
                    } 
                },
                { $match: { count: { $gte: 2 } } }, 
                { $sort: { count: -1 } },
                { $limit: 12 }
            ]);

            const topics = results.map(r => ({
                topic: r._id,
                count: r.count,
                score: r.sampleScore || 0
            }));

            await redisClient.set('trending_topics_smart', topics, 3600);
            return topics;

        } catch (error: any) {
            logger.error(`❌ Stats Update Failed: ${error.message}`);
            return [];
        }
    }

    // 2. Get Global Bias Distribution
    async getGlobalStats() {
        const CACHE_KEY = 'global_bias_stats';
        const cached = await redisClient.get(CACHE_KEY);
        if (cached) return cached;

        const stats = await Article.aggregate([
            { $group: { _id: "$politicalLean", count: { $sum: 1 } } }
        ]);
        
        const result = stats.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {} as Record<string, number>);

        await redisClient.set(CACHE_KEY, result, 3600 * 4);
        return result;
    }

    // 3. Increment Counter
    async increment(metric: string) {
        try {
            if (!redisClient.isReady()) return;
            const client = redisClient.getClient();
            if (!client) return;

            const today = new Date().toISOString().split('T')[0]; 
            const key = `stats:${today}:${metric}`;
            await client.incr(key);
            await client.expire(key, 60 * 60 * 24 * 7);
        } catch (error) {
        }
    }

    // 4. Update User Personalization Vector
    async updateUserVector(userId: string) {
        try {
            if (redisClient.isReady()) {
                const client = redisClient.getClient();
                if (client) {
                    const countKey = `vector_update_count:${userId}`;
                    const count = await client.incr(countKey);
                    if (count % 5 !== 0) return;
                }
            }

            const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' })
                .sort({ timestamp: -1 })
                .limit(50) 
                .select('articleId');

            if (recentLogs.length === 0) return;

            const articleIds = recentLogs.map(log => log.articleId);

            const articles = await Article.find({ 
                _id: { $in: articleIds },
                embedding: { $exists: true, $not: { $size: 0 } }
            }).select('embedding');

            if (articles.length === 0) return;

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

    // 6. Apply Recency Decay
    async applyInterestDecay(userId: string) {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            const lastUpdate = new Date(stats.lastUpdated).getTime();
            const now = Date.now();
            const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

            if (hoursSinceUpdate < 24) return;

            const daysPassed = Math.floor(hoursSinceUpdate / 24);
            const decayFactor = Math.pow(0.95, daysPassed);

            if (stats.leanExposure) {
                stats.leanExposure.Left = Math.round((stats.leanExposure.Left || 0) * decayFactor);
                stats.leanExposure.Center = Math.round((stats.leanExposure.Center || 0) * decayFactor);
                stats.leanExposure.Right = Math.round((stats.leanExposure.Right || 0) * decayFactor);
            }

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

    // 7. Tune Feed (Modify Interests Manually)
    async manageFeedTuning(userId: string, action: string, topic: string) {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return false;

            if (action === 'unmute_topic') {
                if (stats.negativeInterest && stats.negativeInterest.has(topic)) {
                    stats.negativeInterest.delete(topic);
                    logger.info(`🔊 User ${userId} unmuted topic: ${topic}`);
                }
            } 
            else if (action === 'remove_interest') {
                if (stats.topicInterest && stats.topicInterest.has(topic)) {
                    stats.topicInterest.delete(topic);
                    logger.info(`🗑️ User ${userId} removed interest: ${topic}`);
                }
            }

            stats.markModified('topicInterest');
            stats.markModified('negativeInterest');
            await stats.save();
            return true;
        } catch (error) {
            logger.error('Error tuning feed:', error);
            return false;
        }
    }
}

export default new StatsService();
