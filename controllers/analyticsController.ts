// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
import SearchLog from '../models/searchLogModel';
import Article from '../models/articleModel';
import statsService from '../services/statsService';
import redisClient from '../utils/redisClient'; 
import logger from '../utils/logger';

// @desc    Track User Activity (Heartbeat & Beacon)
// @route   POST /api/analytics/track
// @access  Public (Can be anonymous)
export const trackActivity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { 
      sessionId, 
      userId, 
      metrics, 
      interactions, 
      meta 
    } = req.body;

    if (!sessionId) {
      res.status(200).send('ok');
      return;
    }

    // 1. Calculate Quarterly Aggregates (from this payload)
    const payloadQuarters = [0, 0, 0, 0];
    if (interactions) {
        interactions.forEach((i: any) => {
            if (i.quarters && Array.isArray(i.quarters)) {
                i.quarters.forEach((val: number, idx: number) => {
                    if (idx < 4) payloadQuarters[idx] += val;
                });
            }
        });
    }

    // 2. Update Session Analytics (Raw Logs)
    const updateOps: any = {
      $inc: {
        totalDuration: metrics?.total || 0,
        articleDuration: metrics?.article || 0,
        radioDuration: metrics?.radio || 0,
        narrativeDuration: metrics?.narrative || 0,
        feedDuration: metrics?.feed || 0,
        
        // Increment global quarters
        'quarterlyRetention.0': payloadQuarters[0],
        'quarterlyRetention.1': payloadQuarters[1],
        'quarterlyRetention.2': payloadQuarters[2],
        'quarterlyRetention.3': payloadQuarters[3]
      },
      $set: {
        updatedAt: new Date()
      }
    };

    if (interactions && interactions.length > 0) {
      updateOps.$push = { interactions: { $each: interactions } };
    }

    const setOnInsert: any = {
        sessionId,
        date: new Date(),
        platform: meta?.platform || 'web',
        userAgent: meta?.userAgent || 'unknown',
        referrer: meta?.referrer 
    };
    if (userId) setOnInsert.userId = userId;

    await AnalyticsSession.findOneAndUpdate(
      { sessionId },
      { ...updateOps, $setOnInsert: setOnInsert },
      { upsert: true, new: true }
    );

    // 3. Update User Stats (Personalization Profile)
    if (userId) {
        
        // A. Prepare the Update Payload
        const userStatsUpdate: any = { 
            $inc: {}, 
            $set: { lastUpdated: new Date() } 
        };
        let hasUpdates = false;

        // B. Process "Time Spent" on Articles
        if (metrics?.article > 0) {
            const articleInteraction = interactions?.find((i: any) => 
                i.contentType === 'article' && i.contentId
            );

            if (articleInteraction && articleInteraction.contentId) {
                const seconds = metrics.article;
                const articleId = articleInteraction.contentId;
                const wordCount = articleInteraction.wordCount || 0; 
                const quarters = articleInteraction.quarters || [0,0,0,0];

                let isSkimming = false;
                let totalSecondsOnArticle = seconds; 

                // --- REDIS CACHE for Accumulation ---
                if (redisClient.isReady()) {
                    const client = redisClient.getClient();
                    if (client) {
                        const key = `article_time:${userId}:${articleId}`;
                        totalSecondsOnArticle = await client.incrBy(key, seconds);
                        await client.expire(key, 86400); 

                        // --- TRUE READ VALIDATION ---
                        // Rule 1: WPM Check
                        if (wordCount > 50 && totalSecondsOnArticle > 5) {
                            const minutes = totalSecondsOnArticle / 60;
                            const wpm = wordCount / minutes;
                            if (wpm > 600) isSkimming = true;
                        }
                        
                        // Rule 2: Quarter Check
                        const qKey = `article_quarters:${userId}:${articleId}`;
                        if (quarters[2] > 2) await client.setBit(qKey, 2, 1);
                        if (quarters[3] > 2) await client.setBit(qKey, 3, 1);
                        
                        // If they have accumulated > 30s AND hit Q3 or Q4, it's a True Read
                        const readCreditKey = `article_read_credited:${userId}:${articleId}`;
                        const alreadyCredited = await client.get(readCreditKey);

                        if (!alreadyCredited && !isSkimming && totalSecondsOnArticle > 30) {
                            const hitDeep = await client.getBit(qKey, 3); 
                            if (hitDeep === 1) {
                                // CREDIT THE READ
                                await UserStats.updateOne({ userId }, { $inc: { articlesReadCount: 1 } });
                                await client.set(readCreditKey, '1', { EX: 86400 * 30 });
                            }
                        }
                    }
                }

                // Lookup Category & Lean to update Interest Profile
                const article = await Article.findById(articleId).select('category lean_bias');

                if (article) {
                    const category = article.category || 'General';
                    const lean = (article as any).lean_bias || 'Center';
                    const currentHour = new Date().getHours(); 

                    userStatsUpdate.$inc.totalTimeSpent = seconds;
                    userStatsUpdate.$inc[`activityByHour.${currentHour}`] = seconds;

                    // Only add to Interest Profile if not skimming
                    if (!isSkimming) {
                        userStatsUpdate.$inc[`topicInterest.${category}`] = seconds;
                        userStatsUpdate.$inc[`leanExposure.${lean}`] = seconds;
                    }
                    hasUpdates = true;
                }
            }
        }

        // C. Process "Impressions" (Negative/Passive Interest)
        // This runs even if they didn't click anything (just scrolling feed)
        if (interactions && interactions.length > 0) {
            interactions.forEach((i: any) => {
                if (i.contentType === 'impression' && i.text) {
                    // text format is "Type:Category" (e.g., "Article:Technology")
                    const parts = i.text.split(':');
                    if (parts.length === 2) {
                        const category = parts[1];
                        // Increment negative interest count
                        userStatsUpdate.$inc[`negativeInterest.${category}`] = 1;
                        hasUpdates = true;
                    }
                }
            });
        }

        // D. Execute Single Update
        if (hasUpdates) {
             await UserStats.findOneAndUpdate(
                { userId },
                userStatsUpdate,
                { upsert: true }
             );
        }
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error('Analytics Error:', error);
    res.status(200).send('ok'); 
  }
};

// @desc    Link Anonymous Session to User ID
// @route   POST /api/analytics/link-session
// @access  Public
export const linkSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { sessionId, userId } = req.body;
        if (!sessionId || !userId) {
             res.status(400).send('Missing data');
             return; 
        }
        await AnalyticsSession.findOneAndUpdate({ sessionId }, { userId }, { new: true });
        logger.info(`Session Stitched: ${sessionId} -> ${userId}`);
        res.status(200).json({ status: 'linked' });
    } catch (error) {
        next(error);
    }
};

// NEW: Get User Stats for Dashboard
// @desc    Get Personalized User Stats
// @route   GET /api/analytics/user-stats
// @access  Private
export const getUserStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Authenticated user ID from Request (via Middleware) or Query param as fallback
        const userId = (req as any).user?.uid || req.query.userId;
        
        if (!userId) {
             res.status(400).json({ status: 'error', message: 'User ID required' });
             return;
        }

        const stats = await UserStats.findOne({ userId });
        
        // Calculate percentages for the UI
        let leanPercentages = { Left: 0, Center: 0, Right: 0 };
        if (stats && stats.leanExposure) {
            const total = (stats.leanExposure.Left || 0) + (stats.leanExposure.Center || 0) + (stats.leanExposure.Right || 0);
            if (total > 0) {
                leanPercentages = {
                    Left: Math.round((stats.leanExposure.Left / total) * 100),
                    Center: Math.round((stats.leanExposure.Center / total) * 100),
                    Right: Math.round((stats.leanExposure.Right / total) * 100)
                };
            }
        }

        res.status(200).json({
            status: 'success',
            data: {
                ...(stats ? stats.toObject() : {}),
                leanPercentages
            }
        });

    } catch (error) {
        next(error);
    }
};

// @desc    Get Quick Stats (For Admin Overview)
// @route   GET /api/analytics/overview
// @access  Admin
export const getAnalyticsOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);

        const stats = await AnalyticsSession.aggregate([
            { $match: { updatedAt: { $gte: startOfDay } } },
            { 
                $group: {
                    _id: null,
                    activeUsers: { $sum: 1 },
                    totalTime: { $sum: '$totalDuration' },
                    avgTime: { $avg: '$totalDuration' },
                    radioTime: { $sum: '$radioDuration' },
                    articleTime: { $sum: '$articleDuration' }
                }
            }
        ]);

        const topSearches = await SearchLog.find({ zeroResults: false })
            .sort({ count: -1 }).limit(5).select('query count');

        const contentGaps = await SearchLog.find({ zeroResults: true })
            .sort({ count: -1 }).limit(5).select('query count');

        // FIX: Use .lean() to get Plain Objects, avoiding Mongoose Map issues
        const recentStats = await UserStats.find({ lastUpdated: { $gte: startOfDay } })
            .select('activityByHour')
            .limit(100)
            .lean(); 

        const hourlyActivity = new Array(24).fill(0);
        
        // FIX: safe iteration over POJO
        recentStats.forEach((stat: any) => {
            if (stat.activityByHour) {
                Object.entries(stat.activityByHour).forEach(([hour, seconds]) => {
                    const h = parseInt(hour);
                    const s = typeof seconds === 'number' ? seconds : 0;
                    if (!isNaN(h) && h >= 0 && h < 24) {
                        hourlyActivity[h] += s;
                    }
                });
            }
        });

        res.status(200).json({
            status: 'success',
            data: {
                ...(stats[0] || {}),
                topSearches,
                contentGaps,
                hourlyActivity 
            }
        });
    } catch (error) {
        next(error);
    }
};
