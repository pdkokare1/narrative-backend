// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // Keeping your working key
        this.apiKey = 'sk_84859baaf9b9da27f81e79abd1d30827c8bf0ecb454b97aa'.trim();
        this.verifyConnection();
    }

    async verifyConnection() {
        try {
            console.log(`🎙️ Testing ElevenLabs Connection...`);
            const response = await axios.get(`${ELEVENLABS_API_URL}/user`, {
                headers: { 'xi-api-key': this.apiKey }
            });
            console.log(`✅ ElevenLabs Connected! User: ${response.data.subscription.character_count}/${response.data.subscription.character_limit} chars used.`);
        } catch (error) {
            console.error(`❌ ElevenLabs Connection FAILED: ${error.message}`);
        }
    }

    async streamAudio(text, voiceId) {
        if (!this.apiKey) throw new Error("Missing API Key");

        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;
        
        const params = {
            optimize_streaming_latency: 3 
        };

        const data = {
            text: text,
            model_id: "eleven_turbo_v2", 
            voice_settings: {
                // NEWS ANCHOR SETTINGS:
                // High stability = Consistent, serious tone (no random emotion)
                // High similarity = Sticks strictly to the original voice's professional sound
                stability: 0.75,
                similarity_boost: 0.8,
                style: 0.0,      // Keep style low to avoid "over-acting"
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

            console.log(`🎙️ Streaming audio...`);
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
