// routes/ttsRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');

// POST /api/tts/stream
router.post('/stream', async (req, res) => {
    try {
        const { text, voiceId } = req.body;

        if (!text) {
            return res.status(400).json({ error: "Text is required" });
        }

        // Use the voice ID from the frontend (The Premium one)
        // Fallback to Rachel only if frontend sends nothing
        const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; 

        const audioStream = await ttsService.streamAudio(text, targetVoiceId);

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        audioStream.pipe(res);

    } catch (error) {
        console.error("TTS Route Error:", error.message);
        res.status(500).json({ error: "Text-to-speech generation failed." });
    }
});

module.exports = router;
