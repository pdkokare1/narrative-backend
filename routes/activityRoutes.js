// routes/activityRoutes.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler'); // <--- NEW IMPORT

// Models
const ActivityLog = require('../models/activityLogModel');
const Profile = require('../models/profileModel');

// --- 1. Log View (Analysis) ---
router.post('/log-view', asyncHandler(async (req, res) => {
    const { articleId } = req.body;
    if (!articleId) {
        res.status(400);
        throw new Error('ID required');
    }
    
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_analysis' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesViewedCount: 1 } });
    
    res.status(200).json({ message: 'Logged view' });
}));

// --- 2. Log Comparison ---
router.post('/log-compare', asyncHandler(async (req, res) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { comparisonsViewedCount: 1 } });
    res.status(200).json({ message: 'Logged comparison' });
}));

// --- 3. Log Share ---
router.post('/log-share', asyncHandler(async (req, res) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesSharedCount: 1 } });
    res.status(200).json({ message: 'Logged share' });
}));

// --- 4. Log Read (External Link) ---
router.post('/log-read', asyncHandler(async (req, res) => {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'read_external' });
    res.status(200).json({ message: 'Logged read' });
}));

module.exports = router;
