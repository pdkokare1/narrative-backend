// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class TTSService {
    constructor() {
        // --- HARDCODED KEY DEBUGGING ---
        // Your specific key is here.
        this.apiKey = 'sk_e988590a8365ae9980abb85a7a62f09096cbdef083d6b514'; 
        console.log(`🎙️ TTS Service Init. Key loaded: ${this.apiKey.substring(0,4)}...`);
    }

    async streamAudio(text, voiceId) {
        if (!this.apiKey) {
            throw new Error("Server configuration error: Missing API Key");
        }

        const url = `${ELEVENLABS_API_URL}/${voiceId}/stream`;
        
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
                responseType: 'stream' // We want the stream
            });

            console.log(`🎙️ ElevenLabs Stream Started for: "${text.substring(0, 20)}..."`);
            return response.data;

        } catch (error) {
            // Only log the status, not the whole error object to avoid clutter
            const status = error.response ? error.response.status : 'Unknown';
            const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error(`❌ ElevenLabs Error (${status}): ${msg}`);
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
