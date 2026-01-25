// controllers/analyticsController.ts
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
    if (interactions && Array.isArray(interactions)) {
        interactions.forEach((i: any) => {
            if (i.quarters && Array.isArray(i.quarters)) {
                i.quarters.forEach((val: number, idx: number) => {
                    if (idx < 4) payloadQuarters[idx] += val;
                });
            }
        });

        // --- NEW: Process True Reads (Async) ---
        // We do not await this to keep the beacon fast.
        if (userId) {
            Promise.all(interactions.map((interaction: any) => 
                statsService.processInteraction(userId, interaction)
            )).catch(err => logger.error('Interaction Processing Error:', err));
        }
    }

    // 2. Update Session Analytics (Raw Logs)
    const updateOps: any = {
      $inc: {
        totalDuration: metrics?.total || 0,
        articleDuration: metrics?.article || 0,
        radioDuration: metrics?.radio || 0,
        narrativeDuration: metrics?.narrative || 0,
        feedDuration: metrics?.feed || 0,
        'quarterlyRetention.0': payloadQuarters[0],
        'quarterlyRetention.1': payloadQuarters[1],
        'quarterlyRetention.2': payloadQuarters[2],
        'quarterlyRetention.3': payloadQuarters[3],
      },
      $set: { updatedAt: new Date() },
      $push: { interactions: { $each: interactions || [] } } // Append interactions
    };

    // Set static fields only on insert (using setOnInsert) or if missing
    if (userId) updateOps.$set.userId = userId;
    if (meta?.platform) updateOps.$set.platform = meta.platform;
    if (meta?.userAgent) updateOps.$set.userAgent = meta.userAgent;

    await AnalyticsSession.findOneAndUpdate(
      { sessionId },
      updateOps,
      { upsert: true, new: true }
    );

    // 3. Update Real-time User Stats (Lightweight)
    // Heavy updates (True Reads) are handled by statsService.processInteraction above.
    if (userId && metrics?.total > 0) {
        const hour = new Date().getHours().toString();
        const incObject: any = { 
            totalTimeSpent: metrics.total,
            [`activityByHour.${hour}`]: metrics.total 
        };
        
        await UserStats.updateOne(
            { userId }, 
            { $inc: incObject },
            { upsert: true }
        );
    }

    res.status(200).send('ok');
  } catch (error) {
    // Analytics should not crash the app, just log it
    console.error('Track Error:', error);
    res.status(200).send('ok'); 
  }
};

// @desc    Link Anonymous Session to User
// @route   POST /api/analytics/link-session
export const linkSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { sessionId, userId } = req.body;
        if (!sessionId || !userId) {
             res.status(400).json({ message: 'Missing Data' });
             return;
        }

        await AnalyticsSession.updateMany(
            { sessionId },
            { $set: { userId } }
        );
        
        res.status(200).json({ status: 'linked' });
    } catch (error) {
        next(error);
    }
};

// @desc    Get Admin Analytics Dashboard
// @route   GET /api/analytics/dashboard
export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);

        const stats = await AnalyticsSession.aggregate([
            { $match: { updatedAt: { $gte: startOfDay } } },
            {
                $group: {
                    _id: null,
                    activeSessions: { $addToSet: '$sessionId' },
                    totalInteractions: { $sum: { $size: '$interactions' } },
                    totalDuration: { $sum: '$totalDuration' },
                    articleTime: { $sum: '$articleDuration' }
                }
            },
            {
                $project: {
                    activeUsers: { $size: '$activeSessions' },
                    totalInteractions: 1,
                    totalDuration: 1,
                    avgSessionTime: { $divide: ['$totalDuration', { $size: '$activeSessions' }] },
                    articleTime: 1
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
