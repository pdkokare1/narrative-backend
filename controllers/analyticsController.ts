// controllers/analyticsController.ts
import { Request, Response, NextFunction } from 'express';
import AnalyticsSession from '../models/analyticsSession';
import UserStats from '../models/userStatsModel';
import SearchLog from '../models/searchLogModel';
import Profile from '../models/profileModel'; 
import statsService from '../services/statsService';
import analyticsBufferService from '../services/analyticsBufferService'; // NEW IMPORT
import logger from '../utils/logger';

// @desc    Track User Activity (Heartbeat & Beacon)
// @route   POST /api/analytics/track
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
      res.status(200).json({ status: 'ok' });
      return;
    }

    // --- NEW: Abandonment / Bounce Heuristic ---
    // If the user has been active for < 5 seconds AND has performed zero interactions,
    // we consider this a "Bounce" and do not save it to the DB.
    // This dramatically reduces DB noise and improves "Average Time" accuracy.
    const duration = metrics?.total || 0;
    const hasInteractions = interactions && Array.isArray(interactions) && interactions.length > 0;

    if (duration < 5 && !hasInteractions) {
        res.status(200).json({ status: 'ignored_bounce' });
        return;
    }
    // -------------------------------------------

    // --- NEW: Privacy / Incognito Check ---
    if (userId) {
        const profile = await Profile.findOne({ userId }).select('isIncognito');
        if (profile?.isIncognito) {
            // In incognito mode, we do NOT log interactions or update stats.
            res.status(200).json({ status: 'incognito' });
            return;
        }
    }
    // --------------------------------------

    // 1. Calculate Quarterly Aggregates
    const payloadQuarters = [0, 0, 0, 0];
    if (interactions && Array.isArray(interactions)) {
        interactions.forEach((i: any) => {
            if (i.quarters && Array.isArray(i.quarters)) {
                i.quarters.forEach((val: number, idx: number) => {
                    if (idx < 4) payloadQuarters[idx] += val;
                });
            }
        });

        // Async: Process True Reads & Impressions
        if (userId) {
            // NEW: Pass Timezone to stats service for accurate streaks
            const userTimezone = meta?.timezone || 'UTC';
            
            // UPDATED: Await processing to provide immediate feedback
            try {
                await Promise.all(interactions.map((interaction: any) => 
                    statsService.processInteraction(userId, interaction, userTimezone)
                ));
            } catch (err) {
                logger.error('Interaction Processing Error:', err);
            }
        }
    }

    // 2. Update Session Analytics
    // OPTIMIZATION: Moved to Redis Buffer Service to reduce DB Write Load
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
      $push: { interactions: { $each: interactions || [] } }
    };

    if (userId) updateOps.$set.userId = userId;
    if (meta?.platform) updateOps.$set.platform = meta.platform;
    if (meta?.userAgent) updateOps.$set.userAgent = meta.userAgent;

    // Call the Buffer Service instead of Direct Write
    await analyticsBufferService.bufferSessionData(sessionId, updateOps);

    // 3. Update Real-time User Stats (Lightweight)
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

    // 4. CHECK FOR FEEDBACK TRIGGERS (Palate Cleanser & Goals)
    // FIX: Explicitly type command to allow string or null
    let command: string | null = null;
    if (userId) {
        // Updated query to fetch both flags
        const stats = await UserStats.findOne({ userId }).select('suggestPalateCleanser suggestGoalUpgrade');

        if (stats?.suggestPalateCleanser) {
            command = 'trigger_palate_cleanser';
        } else if (stats?.suggestGoalUpgrade) {
            // NEW: Smart Goal Trigger
            command = 'trigger_goal_upgrade';
        }
    }

    res.status(200).json({ status: 'ok', command });

  } catch (error) {
    console.error('Track Error:', error);
    res.status(200).json({ status: 'error' }); 
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

// @desc    Get User Stats (For My Dashboard)
// @route   GET /api/analytics/user-stats
export const getUserStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.uid;
        if (!userId) {
            res.status(400).json({ message: 'User ID required' });
            return;
        }

        // Fetch the Smart Stats (True Reads, Attention Span)
        const stats = await UserStats.findOne({ userId }).lean();

        // NEW: Fetch Gamification Data (Quests & Badges) from Profile
        const profile = await Profile.findOne({ userId }).select('quests badges');

        // If no stats yet, return default structure
        if (!stats) {
            res.status(200).json({
                userId,
                totalTimeSpent: 0,
                articlesReadCount: 0,
                averageAttentionSpan: 0,
                engagementScore: 0,
                dailyStats: {
                    date: new Date(),
                    timeSpent: 0,
                    articlesRead: 0,
                    goalsMet: false
                },
                quests: profile?.quests || [], // Return empty quests if stats missing
                badges: profile?.badges || []
            });
            return;
        }

        // LAZY RESET: If dailyStats is from yesterday, show 0 to the user
        // Note: The actual DB reset happens in statsService on next interaction, 
        // but this ensures the UI looks correct immediately.
        const lastDate = stats.dailyStats?.date ? new Date(stats.dailyStats.date) : new Date(0);
        const isSameDay = lastDate.toDateString() === new Date().toDateString();

        if (!isSameDay) {
            stats.dailyStats = {
                date: new Date(),
                timeSpent: 0,
                articlesRead: 0,
                goalsMet: false
            };
        }

        // MERGE Quests into the response
        const responseData = {
            ...stats,
            quests: profile?.quests || [],
            badges: profile?.badges || []
        };

        res.status(200).json(responseData);
    } catch (error) {
        next(error);
    }
};

// @desc    Get Admin Analytics Overview (Renamed from getDashboardStats)
// @route   GET /api/analytics/overview
export const getAnalyticsOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);

        // 1. Session Stats
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

        // 2. Search Intelligence
        const topSearches = await SearchLog.find({ zeroResults: false })
            .sort({ count: -1 }).limit(5).select('query count');

        const contentGaps = await SearchLog.find({ zeroResults: true })
            .sort({ count: -1 }).limit(5).select('query count');

        // 3. Hourly Activity (Heatmap)
        const recentStats = await UserStats.find({ lastUpdated: { $gte: startOfDay } })
            .select('activityByHour')
            .limit(100)
            .lean(); 

        const hourlyActivity = new Array(24).fill(0);
        
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

        // 4. NEW: Survivorship Bias (Global Negative Interest)
        // Aggregates the 'negativeInterest' map across all users to find what is universally ignored
        const mostIgnored = await UserStats.aggregate([
            { $match: { negativeInterest: { $exists: true, $ne: {} } } },
            { $project: { items: { $objectToArray: "$negativeInterest" } } },
            { $unwind: "$items" },
            { $group: { 
                _id: "$items.k", 
                userCount: { $sum: 1 }, // How many users ignore this
                totalIntensity: { $sum: "$items.v" } // Total negative score
            }},
            { $sort: { userCount: -1 } },
            { $limit: 5 }
        ]);

        res.status(200).json({
            status: 'success',
            data: {
                ...(stats[0] || {}),
                topSearches,
                contentGaps,
                hourlyActivity,
                mostIgnored // New data field
            }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Tune Feed (Unmute/Reset Interest)
// @route   POST /api/analytics/tune-feed
export const tuneUserFeed = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.uid;
        const { action, topic } = req.body;

        if (!userId || !action || !topic) {
            res.status(400).json({ message: 'Missing required parameters' });
            return;
        }

        const success = await statsService.manageFeedTuning(userId, action, topic);
        
        if (success) {
            res.status(200).json({ status: 'success', message: `Topic ${topic} updated.` });
        } else {
            res.status(404).json({ message: 'User stats not found' });
        }
    } catch (error) {
        next(error);
    }
};
