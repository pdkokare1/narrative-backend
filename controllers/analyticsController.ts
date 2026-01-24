// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
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
      metrics, // { article: 5, radio: 0, total: 5 ... }
      interactions, 
      meta 
    } = req.body;

    if (!sessionId) {
      res.status(200).send('ok');
      return;
    }

    // 1. Update Session Analytics (Technical Data)
    const updateOps: any = {
      $inc: {
        totalDuration: metrics.total || 0,
        articleDuration: metrics.article || 0,
        radioDuration: metrics.radio || 0,
        narrativeDuration: metrics.narrative || 0,
        feedDuration: metrics.feed || 0
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

    // 2. Consolidate UserStats Logic
    if (userId && metrics.article > 0) {
        
        // Find the interaction related to the article
        const articleInteraction = interactions?.find((i: any) => 
            i.contentType === 'article' && i.contentId
        );

        if (articleInteraction && articleInteraction.contentId) {
            const seconds = metrics.article;
            const articleId = articleInteraction.contentId;
            const wordCount = articleInteraction.wordCount || 0; 

            // --- SKIMMING DETECTION ---
            let isSkimming = false;
            let totalSecondsOnArticle = seconds; 

            if (redisClient.isReady()) {
                const client = redisClient.getClient();
                if (client) {
                    const key = `article_time:${userId}:${articleId}`;
                    totalSecondsOnArticle = await client.incrBy(key, seconds);
                    await client.expire(key, 86400); 

                    // WPM Check
                    if (wordCount > 50 && totalSecondsOnArticle > 5) {
                        const minutes = totalSecondsOnArticle / 60;
                        const wpm = wordCount / minutes;

                        if (wpm > 600) {
                            isSkimming = true;
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
                
                // NEW: Dayparting (Hour of Day)
                // We use Server Time for now (UTC). 
                const currentHour = new Date().getHours(); // 0-23

                const updatePayload: any = {
                    $inc: {
                        totalTimeSpent: seconds, 
                        [`activityByHour.${currentHour}`]: seconds // Log habit
                    },
                    $set: { lastUpdated: new Date() }
                };

                // Only add to Interest Profile if they are actually reading
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

// @desc    Get Quick Stats (For Admin Overview)
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

        res.status(200).json({
            status: 'success',
            data: stats[0] || {}
        });
    } catch (error) {
        next(error);
    }
};
