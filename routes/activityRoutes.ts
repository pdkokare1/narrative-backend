// routes/activityRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import ActivityLog from '../models/activityLogModel';
import Article from '../models/articleModel'; // Added Article Model
import Profile from '../models/profileModel';
import gamificationService from '../services/gamificationService';
import ttsService from '../services/ttsService'; // Added TTS Service

const router = express.Router();

// --- 1. Log View (Analysis) ---
router.post('/log-view', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body; 
    const userId = req.user.uid;

    // Log Action
    await ActivityLog.create({ userId, articleId, action: 'view_analysis' });
    
    // Update User Stats
    await Profile.findOneAndUpdate({ userId }, { $inc: { articlesViewedCount: 1 } });
    
    // --- SMART AUDIO PRE-FETCH ---
    // Fire and forget logic to check if this article is becoming popular
    (async () => {
        try {
            // Check view count
            const viewCount = await ActivityLog.countDocuments({ articleId, action: 'view_analysis' });
            
            // If popular (>= 5 views) and NO audio yet, generate it now.
            if (viewCount >= 5) {
                const article = await Article.findById(articleId).select('headline summary audioUrl');
                if (article && !article.audioUrl) {
                    console.log(`🔥 Article ${articleId} is trending (${viewCount} views). Auto-generating Audio...`);
                    const text = `${article.headline}. ${article.summary}`;
                    // Use 'Mira' (Anchor) voice by default
                    const url = await ttsService.generateAndUpload(text, 'SmLgXu8CcwHJvjiqq2rw', articleId);
                    
                    article.audioUrl = url;
                    await article.save();
                }
            }
        } catch (err) {
            console.error("Smart Audio Trigger Error:", err);
        }
    })();

    // Check for Badges (Sequential to ensure correct order)
    const streakBadge = await gamificationService.updateStreak(userId);
    const readBadge = await gamificationService.checkReadBadges(userId);
    
    const newBadge = readBadge || streakBadge;

    res.status(200).json({ message: 'Logged view', newBadge });
}));

// --- 2. Log Comparison ---
router.post('/log-compare', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { comparisonsViewedCount: 1 } });
    
    const newBadge = await gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged comparison', newBadge });
}));

// --- 3. Log Share ---
router.post('/log-share', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesSharedCount: 1 } });
    
    const newBadge = await gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged share', newBadge });
}));

// --- 4. Log Read (External Link) ---
router.post('/log-read', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'read_external' });
    
    const newBadge = await gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged read', newBadge });
}));

export default router;
