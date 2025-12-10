// routes/ttsRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');
const Article = require('../models/articleModel'); 
const asyncHandler = require('../utils/asyncHandler');

router.post('/get-audio', asyncHandler(async (req, res) => {
    const { text, voiceId, articleId } = req.body;

    if (!articleId) {
        res.status(400);
        throw new Error("Article ID is required for caching.");
    }

    // 1. Check Database first
    const article = await Article.findById(articleId);
    
    if (article && article.audioUrl) {
        return res.status(200).json({ audioUrl: article.audioUrl });
    }

    // 2. Cache Miss: Generate New Audio
    const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; 
    const newAudioUrl = await ttsService.generateAndUpload(text, targetVoiceId, articleId);

    // 3. Save to Database
    if (article) {
        article.audioUrl = newAudioUrl;
        await article.save();
    }

    res.status(200).json({ audioUrl: newAudioUrl });
}));

module.exports = router;
