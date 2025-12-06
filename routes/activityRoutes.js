// routes/activityRoutes.js
const express = require('express');
const router = express.Router();

// Models
const ActivityLog = require('../models/activityLogModel');
const Profile = require('../models/profileModel');

// --- 1. Log View (Analysis) ---
router.post('/log-view', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId) return res.status(400).json({ error: 'ID required' });
    
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_analysis' });
    // Increment the user's view count
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesViewedCount: 1 } });
    
    res.status(200).json({ message: 'Logged view' });
  } catch (error) { 
    console.error("Log View Error:", error);
    res.status(500).json({ error: 'Log error' }); 
  }
});

// --- 2. Log Comparison ---
router.post('/log-compare', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'view_comparison' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { comparisonsViewedCount: 1 } });
    res.status(200).json({ message: 'Logged comparison' });
  } catch (error) { 
    console.error("Log Compare Error:", error);
    res.status(500).json({ error: 'Log error' }); 
  }
});

// --- 3. Log Share ---
router.post('/log-share', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'share_article' });
    await Profile.findOneAndUpdate({ userId: req.user.uid }, { $inc: { articlesSharedCount: 1 } });
    res.status(200).json({ message: 'Logged share' });
  } catch (error) { 
    console.error("Log Share Error:", error);
    res.status(500).json({ error: 'Log error' }); 
  }
});

// --- 4. Log Read (External Link) ---
router.post('/log-read', async (req, res) => {
  try {
    const { articleId } = req.body;
    await ActivityLog.create({ userId: req.user.uid, articleId, action: 'read_external' });
    res.status(200).json({ message: 'Logged read' });
  } catch (error) { 
    console.error("Log Read Error:", error);
    res.status(500).json({ error: 'Log error' }); 
  }
});

module.exports = router;
