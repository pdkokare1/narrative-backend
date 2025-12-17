// routes/profileRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import Profile from '../models/profileModel';
import ActivityLog from '../models/activityLogModel';
import * as admin from 'firebase-admin';

const router = express.Router();

// --- 1. GET Profile ---
router.get('/me', asyncHandler(async (req: Request, res: Response) => {
    const profile = await Profile.findOne({ userId: req.user!.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles notificationsEnabled currentStreak badges') 
      .lean();
    
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }
    res.status(200).json(profile);
}));

// --- 2. Create / Re-Link Profile ---
router.post('/', validate(schemas.createProfile), asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.body;
    const { uid, email } = req.user!; 
    const cleanUsername = username.trim();

    // A. Check if Username is taken by SOMEONE ELSE
    const usernameOwner = await Profile.findOne({ username: cleanUsername }).lean();
    if (usernameOwner && usernameOwner.email !== email) {
        res.status(409);
        throw new Error('Username already taken by another user.');
    }

    // B. Orphan Check (Relink if email matches but ID differs - rare edge case)
    const existingProfile = await Profile.findOne({ email }).lean();
    if (existingProfile) {
        // Just update the ID linkage if needed
        if (existingProfile.userId !== uid) {
            await Profile.updateOne({ email }, { userId: uid });
        }
        return res.status(200).json(existingProfile);
    }

    // C. Create New
    const newProfile = await Profile.create({
        userId: uid,
        email,
        username: cleanUsername,
        badges: [],
        notificationsEnabled: true
    });

    res.status(201).json(newProfile);
}));

// --- 3. Update Profile (NEW) ---
router.put('/me', validate(schemas.updateProfile), asyncHandler(async (req: Request, res: Response) => {
    const { username, notificationsEnabled } = req.body;
    const userId = req.user!.uid;

    const updates: any = {};

    // Handle Username Change
    if (username) {
        const cleanUsername = username.trim();
        const usernameOwner = await Profile.findOne({ username: cleanUsername }).lean();
        
        // If taken by someone else
        if (usernameOwner && usernameOwner.userId !== userId) {
            res.status(409);
            throw new Error('Username already taken.');
        }
        updates.username = cleanUsername;
    }

    // Handle Settings
    if (typeof notificationsEnabled === 'boolean') {
        updates.notificationsEnabled = notificationsEnabled;
    }

    const updatedProfile = await Profile.findOneAndUpdate(
        { userId },
        { $set: updates },
        { new: true } // Return updated doc
    ).select('username email notificationsEnabled');

    res.status(200).json(updatedProfile);
}));

// --- 4. Save Notification Token ---
router.post('/save-token', asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body;
    if (!token) throw new Error('Token required');

    await Profile.findOneAndUpdate(
        { userId: req.user!.uid },
        { fcmToken: token, notificationsEnabled: true }
    );

    res.status(200).json({ message: 'Token saved' });
}));

// --- 5. Get Statistics (Charts) ---
router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.uid;
    
    // Aggregation pipeline to fetch user stats efficiently
    const stats = await ActivityLog.aggregate([
      { $match: { userId } },
      { 
        $facet: {
          dailyCounts: [
            { $match: { 'action': 'view_analysis' } },
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } },
            { $limit: 30 }, 
            { $project: { _id: 0, date: '$_id', count: 1 } }
          ],
          leanDistribution_read: [
            { $match: { 'action': 'view_analysis' } },
            { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'articleDetails' } },
            { $unwind: '$articleDetails' },
            { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          categoryDistribution_read: [
            { $match: { 'action': 'view_analysis' } },
            { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'articleDetails' } },
            { $unwind: '$articleDetails' },
            { $group: { _id: '$articleDetails.category', count: { $sum: 1 } } },
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          qualityDistribution_read: [
            { $match: { 'action': 'view_analysis' } },
            { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'articleDetails' } },
            { $unwind: '$articleDetails' },
            { $group: { _id: '$articleDetails.credibilityGrade', count: { $sum: 1 } } },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],
          totalCounts: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ],
        }
      }
    ]);

    const results = {
      timeframeDays: 'All Time',
      dailyCounts: stats[0]?.dailyCounts || [],
      leanDistribution_read: stats[0]?.leanDistribution_read || [],
      categoryDistribution_read: stats[0]?.categoryDistribution_read || [],
      qualityDistribution_read: stats[0]?.qualityDistribution_read || [],
      totalCounts: stats[0]?.totalCounts || [],
    };

    res.status(200).json(results);
}));

// --- 6. DELETE Account (Danger Zone) ---
router.delete('/', asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.uid;

    console.log(`🗑️ Deleting account for: ${userId}`);

    // 1. Delete MongoDB Data
    await Profile.deleteOne({ userId });
    await ActivityLog.deleteMany({ userId });

    // 2. Delete from Firebase Auth
    try {
        await admin.auth().deleteUser(userId);
    } catch (err: any) {
        console.warn(`Firebase Delete Failed (User might be already gone): ${err.message}`);
    }

    res.status(200).json({ message: 'Account permanently deleted.' });
}));

export default router;
