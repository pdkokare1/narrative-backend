// routes/profileRoutes.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');

// Models
const Profile = require('../models/profileModel');
const ActivityLog = require('../models/activityLogModel');
const Article = require('../models/articleModel');

// --- 1. GET Profile ---
router.get('/me', asyncHandler(async (req, res) => {
    const profile = await Profile.findOne({ userId: req.user.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles')
      .lean();
    
    if (!profile) {
        res.status(404);
        throw new Error('Profile not found');
    }
    res.status(200).json(profile);
}));

// --- 2. Create / Re-Link Profile (SELF-HEALING FIX) ---
router.post('/', asyncHandler(async (req, res) => {
    const { username } = req.body;
    const { uid, email } = req.user; 

    if (!username || username.trim().length < 3) {
      res.status(400);
      throw new Error('Username must be at least 3 characters');
    }
    const cleanUsername = username.trim();

    // A. Check if this Username is taken by a DIFFERENT email
    const usernameOwner = await Profile.findOne({ username: cleanUsername }).lean();
    if (usernameOwner && usernameOwner.email !== email) {
        res.status(409);
        throw new Error('Username already taken by another user.');
    }

    // B. Check if a profile already exists for this EMAIL (The Orphan Fix)
    let profile = await Profile.findOne({ email: email });

    if (profile) {
        // FOUND: This email exists. We assume it's you.
        // Update the User ID to match your current login (Self-Heal)
        console.log(`🔧 Re-linking orphan profile for ${email}`);
        profile.userId = uid;
        profile.username = cleanUsername; // Update username preference
        await profile.save();
        return res.status(200).json(profile);
    }

    // C. Create New (If email is totally new)
    const newProfile = new Profile({ userId: uid, email: email, username: cleanUsername });
    await newProfile.save();
    res.status(201).json(newProfile);
}));

// --- 3. Weekly Digest (The "Pulse") ---
router.get('/weekly-digest', asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const recentLogs = await ActivityLog.aggregate([
      { $match: { userId: userId, action: 'view_analysis', timestamp: { $gte: sevenDaysAgo } } },
      { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'article' } },
      { $unwind: '$article' },
      { $project: { lean: '$article.politicalLean', category: '$article.category', topic: '$article.clusterTopic' } }
    ]);

    if (!recentLogs || recentLogs.length < 5) {
      return res.status(200).json({ status: 'Insufficient Data', message: "Read more articles to unlock your Weekly Pulse." });
    }

    let score = 0;
    const leanCounts = {};
    const categoryCounts = {};

    recentLogs.forEach(log => {
      leanCounts[log.lean] = (leanCounts[log.lean] || 0) + 1;
      if (log.lean === 'Left') score -= 2;
      else if (log.lean === 'Left-Leaning') score -= 1;
      else if (log.lean === 'Right-Leaning') score += 1;
      else if (log.lean === 'Right') score += 2;
      if (log.category) categoryCounts[log.category] = (categoryCounts[log.category] || 0) + 1;
    });

    const avgScore = score / recentLogs.length;
    let status = 'Balanced';
    let bubbleType = null; 
    
    if (avgScore <= -0.8) { status = 'Left Bubble'; bubbleType = 'Left'; }
    else if (avgScore >= 0.8) { status = 'Right Bubble'; bubbleType = 'Right'; }

    let recommendation = null;
    if (bubbleType) {
      const topCategory = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0] || 'General';
      const targetLeans = bubbleType === 'Left' ? ['Right', 'Right-Leaning', 'Center'] : ['Left', 'Left-Leaning', 'Center'];
      
      recommendation = await Article.findOne({
        category: topCategory,
        politicalLean: { $in: targetLeans },
        trustScore: { $gt: 75 }
      })
      .sort({ publishedAt: -1 })
      .select('headline summary politicalLean source _id')
      .lean();
    }

    res.status(200).json({
      status,
      avgScore,
      articleCount: recentLogs.length,
      recommendation,
      topCategory: Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0]
    });
}));

// --- 4. User Stats (Dashboard Data) ---
router.get('/stats', asyncHandler(async (req, res) => {
    const userId = req.user.uid;
    const stats = await ActivityLog.aggregate([
      { $match: { userId: userId } },
      { $lookup: { from: 'articles', localField: 'articleId', foreignField: '_id', as: 'articleDetails' } },
      { $unwind: { path: '$articleDetails', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          dailyCounts: [
            { $match: { action: 'view_analysis' } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } },
            { $sort: { '_id': 1 } }, { $project: { _id: 0, date: '$_id', count: 1 } }
          ],
          leanDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          leanDistribution_shared: [
             { $match: { 'action': 'share_article' } },
            { $group: { _id: '$articleDetails.politicalLean', count: { $sum: 1 } } },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
          categoryDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.category', count: { $sum: 1 } } },
             { $sort: { count: -1 } }, { $limit: 10 },
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          qualityDistribution_read: [
             { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.credibilityGrade', count: { $sum: 1 } } },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],
          totalCounts: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ],
          topSources_read: [
            { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.source', count: { $sum: 1 } } },
            { $sort: { count: -1 } }, { $limit: 10 },
            { $project: { _id: 0, source: '$_id', count: 1 } }
          ],
          sentimentDistribution_read: [
            { $match: { 'action': 'view_analysis' } },
            { $group: { _id: '$articleDetails.sentiment', count: { $sum: 1 } } },
            { $project: { _id: 0, sentiment: '$_id', count: 1 } }
          ]
        }
      }
    ]);

    const results = {
      timeframeDays: 'All Time',
      dailyCounts: stats[0]?.dailyCounts || [],
      leanDistribution_read: stats[0]?.leanDistribution_read || [],
      leanDistribution_shared: stats[0]?.leanDistribution_shared || [],
      categoryDistribution_read: stats[0]?.categoryDistribution_read || [],
      qualityDistribution_read: stats[0]?.qualityDistribution_read || [],
      totalCounts: stats[0]?.totalCounts || [],
      topSources_read: stats[0]?.topSources_read || [],
      sentimentDistribution_read: stats[0]?.sentimentDistribution_read || []
    };
    res.status(200).json(results);
}));

module.exports = router;
