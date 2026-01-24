// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
import Article from '../models/articleModel';
import statsService from '../services/statsService';
import redisClient from '../utils/redisClient'; // NEW: For ephemeral time tracking
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
      interactions, // Current active interaction array
      meta 
    } = req.body;

    if (!sessionId) {
      // Beacon requests might be silent, so we just return
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
        // NEW: Capture referrer if available
        // referrer: meta?.referrer 
    };
    if (userId) setOnInsert.userId = userId;

    // Upsert Analytics Session
    await AnalyticsSession.findOneAndUpdate(
      { sessionId },
      { ...updateOps, $setOnInsert: setOnInsert },
      { upsert: true, new: true }
    );

    // 2. NEW: Consolidate UserStats Logic (Qualitative View Check)
    // Only update stats if the user has engaged for > 10 seconds to filter out bounces.
    const ENGAGEMENT_THRESHOLD = 10; 

    if (userId && metrics.article > 0) {
        
        // Find the interaction related to the article to get the ID
        const articleInteraction = interactions?.find((i: any) => 
            i.contentType === 'article' && i.contentId
        );

        if (articleInteraction && articleInteraction.contentId) {
            const seconds = metrics.article;
            const articleId = articleInteraction.contentId;
            const wordCount = articleInteraction.wordCount || 0; // NEW: Get word count from frontend

            // --- SKIMMING DETECTION ---
            let isSkimming = false;
            let totalSecondsOnArticle = seconds; // Default to current delta if Redis fails

            if (redisClient.isReady()) {
                const client = redisClient.getClient();
                if (client) {
                    const key = `article_time:${userId}:${articleId}`;
                    // Increment total time spent on this article (Ephemeral)
                    // Expire after 24h to keep Redis clean
                    totalSecondsOnArticle = await client.incrBy(key, seconds);
                    await client.expire(key, 86400); 

                    // Calculate WPM (Words Per Minute)
                    // Formula: Words / (Minutes)
                    if (wordCount > 50 && totalSecondsOnArticle > 5) {
                        const minutes = totalSecondsOnArticle / 60;
                        const wpm = wordCount / minutes;

                        // Threshold: > 600 WPM is considered skimming/scrolling fast
                        if (wpm > 600) {
                            isSkimming = true;
                        }
                    }
                }
            }

            // Lookup Category & Lean for this article
            const article = await Article.findById(articleId)
                .select('category lean_bias');

            if (article) {
                const category = article.category || 'General';
                const lean = (article as any).lean_bias || 'Center';

                // LOGIC:
                // 1. "Total Time" is always updated (Engagement is Engagement).
                // 2. "Topic Interest" & "Lean Exposure" (Echo Chamber) are only updated if NOT Skimming.
                //    This ensures our personalization engine is fed by "Deep Reading", not "Fast Scrolling".

                const updatePayload: any = {
                    $inc: {
                        totalTimeSpent: seconds, // Always count time
                    },
                    $set: { lastUpdated: new Date() }
                };

                // Only add to Interest Profile if they are actually reading
                if (!isSkimming) {
                    updatePayload.$inc[`topicInterest.${category}`] = seconds;
                    updatePayload.$inc[`leanExposure.${lean}`] = seconds;
                }

                // Atomic Update to UserStats
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
    // Analytics should never crash the app, just log error
    logger.error('Analytics Error:', error);
    res.status(200).send('ok'); // Always reply success to client
  }
};

// @desc    Get Quick Stats (For Admin Overview)
// @route   GET /api/analytics/overview
// @access  Admin
export const getAnalyticsOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Simple aggregation for "Today"
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
