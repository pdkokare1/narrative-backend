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

    // 2. Update Session Analytics
    const updateOps: any = {
      $inc: {
        totalDuration: metrics.total || 0,
        articleDuration: metrics.article || 0,
        radioDuration: metrics.radio || 0,
        narrativeDuration: metrics.narrative || 0,
        feedDuration: metrics.feed || 0,
        
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

    // 3. Consolidate UserStats Logic
    if (userId && metrics.article > 0) {
        
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
                    // FIX: Use camelCase 'setBit' for Redis v4+
                    const qKey = `article_quarters:${userId}:${articleId}`;
                    if (quarters[2] > 2) await client.setBit(qKey, 2, 1);
                    if (quarters[3] > 2) await client.setBit(qKey, 3, 1);
                    
                    // If they have accumulated > 30s AND hit Q3 or Q4, it's a True Read
                    const readCreditKey = `article_read_credited:${userId}:${articleId}`;
                    const alreadyCredited = await client.get(readCreditKey);

                    if (!alreadyCredited && !isSkimming && totalSecondsOnArticle > 30) {
                        // FIX: Use camelCase 'getBit'
                        const hitDeep = await client.getBit(qKey, 3); 
                        if (hitDeep === 1) {
                            // CREDIT THE READ
                            await UserStats.updateOne({ userId }, { $inc: { articlesReadCount: 1 } });
                            
                            // FIX: Use options object { EX: seconds } for Redis v4+
                            await client.set(readCreditKey, '1', { EX: 86400 * 30 });
                        }
                    }
                }
            }

            // Lookup Category & Lean
            const article = await Article.findById(articleId)
                .select('category lean_bias');

            if (article) {
                const category = article.category || 'General';
                const lean = (article as any).lean_bias || 'Center';
                const currentHour = new Date().getHours(); 

                const updatePayload: any = {
                    $inc: {
                        totalTimeSpent: seconds, 
                        [`activityByHour.${currentHour}`]: seconds 
                    },
                    $set: { lastUpdated: new Date() }
                };

                // Only add to Interest Profile if not skimming
                if (!isSkimming) {
                    updatePayload.$inc[`topicInterest.${category}`] = seconds;
                    updatePayload.$inc[`leanExposure.${lean}`] = seconds;
                }

                await UserStats.findOneAndUpdate(
                    { userId },
                    updatePayload,
                    { upsert: true }
                );
            }
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
