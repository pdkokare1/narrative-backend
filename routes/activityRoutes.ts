// routes/activityRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
// @ts-ignore
import gamificationService from '../services/gamificationService';

const router = express.Router();

// --- 1. Log View (Analysis) ---
router.post('/log-view', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body; 
    
    // Log Action
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_analysis' });
    
    // Update Stats
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesViewedCount: 1 } });
    
    // Trigger Gamification (Fire & Forget)
    gamificationService.updateStreak(req.user.uid).catch((err: any) => console.error("Gamification Error:", err));
    gamificationService.checkReadBadges(req.user.uid).catch((err: any) => console.error("Badge Error:", err));
    
    res.status(200).json({ message: 'Logged view' });
}));

// --- 2. Log Comparison ---
router.post('/log-compare', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { comparisonsViewedCount: 1 } });
    
    // Comparisons also count for streaks
    gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged comparison' });
}));

// --- 3. Log Share ---
router.post('/log-share', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesSharedCount: 1 } });
    
    // Sharing counts for streaks
    gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged share' });
}));

// --- 4. Log Read (External Link) ---
router.post('/log-read', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'read_external' });
    // Note: We don't increment viewed count here to avoid double counting if they viewed analysis first
    
    gamificationService.updateStreak(req.user.uid);

    res.status(200).json({ message: 'Logged read' });
}));

export default router;
