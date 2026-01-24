// narrative-backend/controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
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
      interactions, // Current active interaction
      meta 
    } = req.body;

    if (!sessionId) {
      // Beacon requests might be silent, so we just return
      res.status(200).send('ok');
      return;
    }

    // Prepare atomic update
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

    // If there is specific interaction data, push it
    if (interactions && interactions.length > 0) {
      updateOps.$push = { interactions: { $each: interactions } };
    }

    // Set metadata only if it's a new document (using setOnInsert)
    const setOnInsert: any = {
        sessionId,
        date: new Date(), // Will verify logic to ensure "today"
        platform: meta?.platform || 'web',
        userAgent: meta?.userAgent || 'unknown',
    };
    if (userId) setOnInsert.userId = userId;

    // Upsert: Create if doesn't exist, Update if it does
    await AnalyticsSession.findOneAndUpdate(
      { sessionId },
      { 
        ...updateOps, 
        $setOnInsert: setOnInsert 
      },
      { upsert: true, new: true }
    );

    // logger.info(`Analytics Heartbeat: ${sessionId} (+${metrics.total}s)`);

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
