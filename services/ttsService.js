// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // Keeping your working key hardcoded
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
        
        // UPGRADE: Using Turbo v2 for faster latency (Best for News Radio)
        const params = {
            optimize_streaming_latency: 3 
        };

        const data = {
            text: text,
            model_id: "eleven_turbo_v2", 
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.7
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

            console.log(`🎙️ Streaming audio via Turbo...`);
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
