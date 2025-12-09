// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // Keeping your verified key
        this.apiKey = 'sk_84859baaf9b9da27f81e79abd1d30827c8bf0ecb454b97aa'.trim();
        console.log(`🎙️ TTS Service Init. Key starts with: ${this.apiKey.substring(0,4)}...`);
    }

    /**
     * Prepares text for News Reading (Teleprompter Mode)
     */
    cleanTextForNews(text) {
        if (!text) return "";
        let clean = text;

        // 1. Explicitly say "Quote" for dialogue
        clean = clean.replace(/["“”]/g, " quote ");

        // 2. Soften Dashes
        clean = clean.replace(/[-—]/g, ", ");

        // 3. Flatten Colons
        clean = clean.replace(/:/g, ".");

        // 4. Remove excessive whitespace
        clean = clean.replace(/\s+/g, " ");

        return clean;
    }

    async streamAudio(text, voiceId) {
        if (!this.apiKey) throw new Error("Missing API Key");

        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;
        
        // "Teleprompter" Scrub
        const safeText = this.cleanTextForNews(text);

        // High Energy / News Anchor Settings
        const params = {
            optimize_streaming_latency: 3 
        };

        const data = {
            text: safeText,
            model_id: "eleven_turbo_v2", 
            voice_settings: {
                // Lower stability = More expressive/energetic
                stability: 0.50,
                // High similarity = Keeps the voice identity strong
                similarity_boost: 0.75,
                // Style > 0 = Adds "acting" (punchiness)
                style: 0.35,
                // Speaker Boost = Adds volume and clarity
                use_speaker_boost: true
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
