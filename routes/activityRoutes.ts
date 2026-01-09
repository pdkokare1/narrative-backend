// routes/activityRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import ActivityLog from '../models/activityLogModel';
import Article from '../models/articleModel'; 
import Profile from '../models/profileModel';
import UserStats from '../models/userStatsModel'; // NEW: For Time Tracking
import gamificationService from '../services/gamificationService';
import ttsService from '../services/ttsService'; 
import authMiddleware from '../middleware/authMiddleware'; // Ensure Auth is used

const router = express.Router();

// Apply Auth Middleware to all routes
router.use(authMiddleware);

// --- HELPER: Update User Personalization Vector ---
// Calculates the "Average Taste" based on last 50 reads
async function updateUserVector(userId: string) {
    try {
        // 1. Get last 50 viewed article IDs
        const recentLogs = await ActivityLog.find({ userId, action: 'view_analysis' })
            .sort({ timestamp: -1 })
            .limit(50) 
            .select('articleId');

        if (recentLogs.length === 0) return;

        const articleIds = recentLogs.map(log => log.articleId);

        // 2. Fetch embeddings for these articles
        const articles = await Article.find({ 
            _id: { $in: articleIds },
            embedding: { $exists: true, $not: { $size: 0 } }
        }).select('embedding');

        if (articles.length === 0) return;

        // 3. Calculate Average Vector (Centroid)
        const vectorLength = articles[0].embedding!.length;
        const avgVector = new Array(vectorLength).fill(0);

        articles.forEach(article => {
            const vec = article.embedding!;
            for (let i = 0; i < vectorLength; i++) {
                avgVector[i] += vec[i];
            }
        });

        // Divide by count to get average
        for (let i = 0; i < vectorLength; i++) {
            avgVector[i] = avgVector[i] / articles.length;
        }

        // 4. Update Profile
        await Profile.updateOne({ userId }, { userEmbedding: avgVector });

    } catch (error) {
        console.error("❌ Vector Update Failed:", error);
    }
}

// --- 1. Log View (Analysis) ---
router.post('/log-view', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body; 
    const userId = (req as any).user.uid;

    // Log Action
    await ActivityLog.create({ userId, articleId, action: 'view_analysis' });
    
    // Update User Stats
    await Profile.findOneAndUpdate({ userId }, { $inc: { articlesViewedCount: 1 } });
    
    // --- SMART AUDIO PRE-FETCH ---
    (async () => {
        try {
            const viewCount = await ActivityLog.countDocuments({ articleId, action: 'view_analysis' });
            if (viewCount >= 5) {
                const article = await Article.findById(articleId).select('headline summary audioUrl');
                if (article && !article.audioUrl) {
                    const text = `${article.headline}. ${article.summary}`;
                    const url = await ttsService.generateAndUpload(text, 'SmLgXu8CcwHJvjiqq2rw', articleId);
                    article.audioUrl = url;
                    await article.save();
                }
            }
        } catch (err) {
            console.error("Smart Audio Trigger Error:", err);
        }
    })();

    // --- UPDATE PERSONALIZATION VECTOR ---
    updateUserVector(userId).catch(err => console.error(err));

    // Check for Badges
    const streakBadge = await gamificationService.updateStreak(userId);
    const readBadge = await gamificationService.checkReadBadges(userId);
    const newBadge = readBadge || streakBadge;

    res.status(200).json({ message: 'Logged view', newBadge });
}));

// --- 2. Log Comparison ---
router.post('/log-compare', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    const userId = (req as any).user.uid;

    await ActivityLog.create({ userId, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId }, { $inc: { comparisonsViewedCount: 1 } });
    
    const newBadge = await gamificationService.updateStreak(userId);

    res.status(200).json({ message: 'Logged comparison', newBadge });
}));

// --- 3. Log Share ---
router.post('/log-share', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    const userId = (req as any).user.uid;

    await ActivityLog.create({ userId, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId }, { $inc: { articlesSharedCount: 1 } });
    
    const newBadge = await gamificationService.updateStreak(userId);

    res.status(200).json({ message: 'Logged share', newBadge });
}));

// --- 4. Log Read (External Link) ---
router.post('/log-read', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    const userId = (req as any).user.uid;

    await ActivityLog.create({ userId, articleId, action: 'read_external' });
    
    // Also update vector on external read
    updateUserVector(userId).catch(err => console.error(err));

    const newBadge = await gamificationService.updateStreak(userId);

    res.status(200).json({ message: 'Logged read', newBadge });
}));

// --- 5. NEW: Heartbeat (Time Tracking) ---
// This is the ONLY new addition to your file
router.post('/heartbeat', asyncHandler(async (req: Request, res: Response) => {
  const { seconds, category, lean } = req.body;
  const userId = (req as any).user.uid;

  if (!seconds || seconds <= 0) return res.status(200).json({ status: 'ignored' });

  // Update Aggregate Stats atomically (UserStats Model)
  const updateOps: any = {
      $inc: {
          totalTimeSpent: seconds,
          [`topicInterest.${category}`]: seconds,
          [`leanExposure.${lean || 'Center'}`]: seconds
      },
      $set: { lastUpdated: new Date() }
  };

  // Upsert ensures document is created if it doesn't exist
  await UserStats.findOneAndUpdate(
      { userId },
      updateOps,
      { upsert: true, new: true }
  );

  res.status(200).json({ status: 'pulsed' });
}));

export default router;
