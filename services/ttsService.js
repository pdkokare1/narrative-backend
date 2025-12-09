// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // Your verified key
        this.apiKey = 'sk_84859baaf9b9da27f81e79abd1d30827c8bf0ecb454b97aa'.trim();
        
        console.log(`🎙️ TTS Service Init. Key starts with: ${this.apiKey.substring(0,4)}...`);
    }

    /**
     * Prepares text for News Reading:
     * 1. Replaces quotes "..." with the spoken word "quote".
     * 2. Replaces dashes - with commas to prevent long pauses.
     * 3. Flattens colons : to periods.
     */
    cleanTextForNews(text) {
        if (!text) return "";
        let clean = text;

        // 1. Explicitly say "Quote" for dialogue
        // Replaces " or “ or ” with the word " quote "
        clean = clean.replace(/["“”]/g, " quote ");

        // 2. Soften Dashes (Stops the AI from taking dramatic pauses)
        // Replaces - or — with a simple comma
        clean = clean.replace(/[-—]/g, ", ");

        // 3. Flatten Colons (Stops "Announcement" style pauses)
        clean = clean.replace(/:/g, ".");

        // 4. Remove excessive whitespace created by replacements
        clean = clean.replace(/\s+/g, " ");

        return clean;
    }

    async streamAudio(text, voiceId) {
        if (!this.apiKey) throw new Error("Missing API Key");

        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;
        
        // Apply the "Teleprompter Scrub"
        const safeText = this.cleanTextForNews(text);

        // Settings tuned for "Flat News Anchor" style
        const params = {
            optimize_streaming_latency: 3 
        };

        const data = {
            text: safeText,
            model_id: "eleven_turbo_v2", 
            voice_settings: {
                // VERY HIGH stability (0.85) = Monotone, serious, consistent
                stability: 0.85,
                // High similarity (0.80) = Sticks to the original voice tone
                similarity_boost: 0.8,
                style: 0.0,
                // DISABLED Speaker Boost = Flattens volume range (less "bouncy")
                use_speaker_boost: false 
            }
        };

        try {
            const response = await axios.post(url, data, {
                headers: {
                    'xi-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                params: params,
                responseType: 'stream'
            });

            console.log(`🎙️ News Anchor Reading: "${safeText.substring(0, 20)}..."`);
            return response.data;

        } catch (error) {
            const status = error.response ? error.response.status : 'Unknown';
            const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error(`❌ ElevenLabs Error (${status}): ${msg}`);
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
