// routes/ttsRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');
const Article = require('../models/articleModel'); // Need this to check the DB

// POST /api/tts/get-audio
// Input: { text, voiceId, articleId }
// Output: { audioUrl: "https://res.cloudinary.com/..." }
router.post('/get-audio', async (req, res) => {
    try {
        const { text, voiceId, articleId } = req.body;

        if (!articleId) {
            return res.status(400).json({ error: "Article ID is required for caching." });
        }

        // 1. Check Database first (The Cache)
        const article = await Article.findById(articleId);
        
        if (article && article.audioUrl) {
            console.log(`✨ Cache Hit: Returning saved audio for "${article.headline}"`);
            return res.status(200).json({ audioUrl: article.audioUrl });
        }

        // 2. Cache Miss: Generate New Audio
        console.log(`🎙️ Cache Miss: Generating new audio for "${article?.headline || 'Unknown'}"...`);
        
        const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Default to Rachel
        
        // This uploads to Cloudinary and returns the secure link
        const newAudioUrl = await ttsService.generateAndUpload(text, targetVoiceId, articleId);

        // 3. Save link to Database so we never generate this again
        if (article) {
            article.audioUrl = newAudioUrl;
            await article.save();
        }

        // 4. Send the URL to the frontend
        res.status(200).json({ audioUrl: newAudioUrl });

    } catch (error) {
        console.error("TTS Route Error:", error.message);
        res.status(500).json({ error: "Audio generation failed." });
    }
});

module.exports = router;
