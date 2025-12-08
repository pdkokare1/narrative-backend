// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class TTSService {
    constructor() {
        // --- HARDCODED KEY DEBUGGING ---
        // Updated with the FRESH key you just provided
        this.apiKey = 'sk_e988590a8365ae9980abb85a7a62f09096cbdef083d6b514'.trim(); 
        
        console.log(`🎙️ TTS Service Init. Key starts with: ${this.apiKey.substring(0,4)}...`);
    }

    async streamAudio(text, voiceId) {
        // Fallback checks
        if (!this.apiKey) {
            console.error("CRITICAL: ElevenLabs API Key is missing.");
            throw new Error("Server configuration error: Missing API Key");
        }

        const url = `${ELEVENLABS_API_URL}/${voiceId}/stream`;
        
        // optimize_streaming_latency: 3 = Fastest response time
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
                responseType: 'stream' // Crucial: We receive binary audio
            });

            console.log(`🎙️ ElevenLabs Stream Started for: "${text.substring(0, 15)}..."`);
            return response.data;

        } catch (error) {
            // Log only the essential error message to keep logs clean
            const status = error.response ? error.response.status : 'Unknown';
            const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error(`❌ ElevenLabs Error (${status}): ${msg}`);
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
