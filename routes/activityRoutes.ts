// routes/activityRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import ActivityLog from '../models/activityLogModel';
import Article from '../models/articleModel'; 
import Profile from '../models/profileModel';
import gamificationService from '../services/gamificationService';
import ttsService from '../services/ttsService'; 
import statsService from '../services/statsService'; // NEW: Import Stats Service
import { checkAuth } from '../middleware/authMiddleware'; 

const router = express.Router();

// Apply Auth Middleware to all routes
router.use(checkAuth); 

// --- 1. Log View (Analysis) ---
router.post('/log-view', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body; 
    const userId = (req as any).user.uid;

    // Log Action
    await ActivityLog.create({ userId, articleId, action: 'view_analysis' });
    
    // Update User Stats (Profile Counter)
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
    // Moved to Service to keep route clean. Fire and forget.
    statsService.triggerVectorUpdate(userId).catch(err => console.error(err));

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
    statsService.triggerVectorUpdate(userId).catch(err => console.error(err));

    const newBadge = await gamificationService.updateStreak(userId);

    res.status(200).json({ message: 'Logged read', newBadge });
}));

export default router;
