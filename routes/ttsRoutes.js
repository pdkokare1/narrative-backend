// routes/ttsRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');

// Safe Voice ID (Rachel)
const SAFE_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

// POST /api/tts/stream
router.post('/stream', async (req, res) => {
    try {
        const { text } = req.body; // Ignore voiceId from frontend for now

        if (!text) {
            return res.status(400).json({ error: "Text is required" });
        }

        console.log(`🎙️ Backend Request: Streaming text...`);

        // FORCE SAFE VOICE
        const audioStream = await ttsService.streamAudio(text, SAFE_VOICE_ID);

        // Set proper headers
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Pipe audio
        audioStream.pipe(res);

    } catch (error) {
        console.error("TTS Route Error:", error.message);
        res.status(500).json({ error: "Text-to-speech generation failed." });
    }
});

module.exports = router;
