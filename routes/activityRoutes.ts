// routes/activityRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import ActivityLog from '../models/activityLogModel';
import Profile from '../models/profileModel';
import gamificationService from '../services/gamificationService';

const router = express.Router();

// --- 1. Log View (Analysis) ---
router.post('/log-view', validate(schemas.logActivity), asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.body; 
    
    // Log Action
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_analysis' });
    
    // Update Stats
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesViewedCount: 1 } });
    
    // Check for Badges (Sequential to ensure correct order)
    const streakBadge = await gamificationService.updateStreak(req.user.uid);
    const readBadge = await gamificationService.checkReadBadges(req.user.uid);
    
    // Prioritize showing the read badge if both happen at once, or streak if that's all we got
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
