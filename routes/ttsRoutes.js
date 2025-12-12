// routes/ttsRoutes.js (FINAL v5.1 - Secured)
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');
const Article = require('../models/articleModel'); 
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate'); // <--- NEW
const schemas = require('../utils/validationSchemas'); // <--- NEW

// --- Generate/Get Audio (Validated) ---
// Protected by 'validate(schemas.getAudio)'
router.post('/get-audio', validate(schemas.getAudio), asyncHandler(async (req, res) => {
    const { text, voiceId, articleId } = req.body;

    // 1. Check Database first (Cache Hit)
    const article = await Article.findById(articleId);
    
    if (article && article.audioUrl) {
        return res.status(200).json({ audioUrl: article.audioUrl });
    }

    // 2. Cache Miss: Generate New Audio
    const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Default voice if none provided
    const newAudioUrl = await ttsService.generateAndUpload(text, targetVoiceId, articleId);

    // 3. Save to Database
    if (article) {
        article.audioUrl = newAudioUrl;
        await article.save();
    }

    res.status(200).json({ audioUrl: newAudioUrl });
}));

module.exports = router;
