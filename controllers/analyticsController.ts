// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
import Article from '../models/articleModel';
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
        // NEW: Capture referrer if available (requires Schema update to persist, but good to have in logic)
        // referrer: meta?.referrer 
    };
    if (userId) setOnInsert.userId = userId;

    // Upsert Analytics Session
    await AnalyticsSession.findOneAndUpdate(
      { sessionId },
      { ...updateOps, $setOnInsert: setOnInsert },
      { upsert: true, new: true }
    );

    // 2. NEW: Consolidate UserStats Logic (Fixing the Disconnect)
    // If we have a valid UserId and they spent time on an Article, update their Profile Stats immediately.
    if (userId && metrics.article > 0) {
        // Find the interaction related to the article to get the ID
        const articleInteraction = interactions?.find((i: any) => 
            i.contentType === 'article' && i.contentId
        );

        if (articleInteraction && articleInteraction.contentId) {
            // Lookup Category & Lean for this article
            // NOTE: We do a lightweight select to keep it fast
            const article = await Article.findById(articleInteraction.contentId)
                .select('category lean_bias');

            if (article) {
                const category = article.category || 'General';
                const lean = article.lean_bias || 'Center';
                const seconds = metrics.article;

                // Atomic Update to UserStats
                // This replaces the old /heartbeat route logic
                await UserStats.findOneAndUpdate(
                    { userId },
                    {
                        $inc: {
                            totalTimeSpent: seconds,
                            [`topicInterest.${category}`]: seconds,
                            [`leanExposure.${lean}`]: seconds
                        },
                        $set: { lastUpdated: new Date() }
                    },
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
        // Simple aggregation for \"Today\"
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
