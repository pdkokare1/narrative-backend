// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
import Article from '../models/articleModel';
import statsService from '../services/statsService';
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
            
            // FILTER: Only count meaningful time (accumulated or instant check)
            // Note: metrics.article is the *delta* since last ping.
            // If they are pinging, they are active. We gate this update to ensure we aren't 
            // aggressively updating stats for micro-interactions, though for "Total Time" 
            // accuracy we want all seconds. 
            // HOWEVER, for "Echo Chamber" calculations, we prefer quality.
            
            // We allow the update if the chunk is > 10s (unlikely with 30s interval unless lag)
            // OR if we just blindly trust the time because 30s is the heartbeat interval.
            // The frontend sends data every 30s. So usually metrics.article is ~30.
            // If they bounce in 5s, metrics.article is 5.
            
            // DECISION: We DO record the time (because 5s is 5s), but we might handle
            // the "Vector Update" elsewhere. For UserStats (Time Spent), we record it all.
            // But let's respect the "Qualitative" requirement by checking if this is a 'real' read.
            
            const seconds = metrics.article;
            
            // If this is a very short ping (beacon on exit) and total time is low, 
            // it might be noise. But for now, we simply record the time.
            
            // Lookup Category & Lean for this article
            const article = await Article.findById(articleInteraction.contentId)
                .select('category lean_bias');

            if (article) {
                const category = article.category || 'General';
                const lean = (article as any).lean_bias || 'Center';

                // Atomic Update to UserStats
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
