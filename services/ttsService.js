// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // Your Key (sk_848...)
        this.apiKey = 'sk_84859baaf9b9da27f81e79abd1d30827c8bf0ecb454b97aa'.trim();
        
        // Run a verification check immediately when server starts
        this.verifyConnection();
    }

    async verifyConnection() {
        try {
            console.log(`🎙️ Testing ElevenLabs Connection...`);
            // Simple GET request to check user info. If this fails, the Key/Account is bad.
            const response = await axios.get(`${ELEVENLABS_API_URL}/user`, {
                headers: { 'xi-api-key': this.apiKey }
            });
            console.log(`✅ ElevenLabs Connected! User: ${response.data.subscription.character_count}/${response.data.subscription.character_limit} chars used.`);
        } catch (error) {
            console.error(`❌ ElevenLabs Connection FAILED. Status: ${error.response?.status}`);
            console.error(`❌ Reason: ${JSON.stringify(error.response?.data || error.message)}`);
        }
    }

    async streamAudio(text, voiceId) {
        if (!this.apiKey) throw new Error("Missing API Key");

        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;
        
        // CHANGED: Use the most compatible model and remove latency optimizations
        const data = {
            text: text,
            model_id: "eleven_multilingual_v2", // More compatible than Turbo
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
            }
        };

        try {
            const response = await axios.post(url, data, {
                headers: {
                    'xi-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                responseType: 'stream' 
            });

            console.log(`🎙️ Streaming audio...`);
            return response.data;

        } catch (error) {
            console.error("ElevenLabs Stream Error:", error.message);
            // If it's a stream error, we can't easily read the JSON body, 
            // but the verifyConnection() logs above should tell us the real reason.
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
