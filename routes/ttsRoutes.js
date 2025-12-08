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

        // Default voice ID if none provided (using the one you selected)
        const targetVoiceId = voiceId || 'tNIuvXGG5RnGdTbvfnPR'; 

        // Get the stream from the service
        const audioStream = await ttsService.streamAudio(text, targetVoiceId);

        // Set proper headers for audio streaming
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Pipe the audio directly to the client (Frontend)
        audioStream.pipe(res);

    } catch (error) {
        console.error("TTS Route Error:", error);
        res.status(500).json({ error: "Text-to-speech generation failed." });
    }
});

module.exports = router;
