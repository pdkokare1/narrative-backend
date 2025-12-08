// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class TTSService {
    constructor() {
        // --- HARDCODED KEY DEBUGGING ---
        // Replace the string below with your FRESH key
        this.apiKey = 'sk_e988590a8365ae9980abb85a7a62f09096cbdef083d6b514'; 
        
        // Log the first 4 characters to console on startup to verify it loaded
        console.log(`🎙️ TTS Service Init. Key starts with: ${this.apiKey ? this.apiKey.substring(0,4) : 'MISSING'}...`);
    }

    /**
     * Streams audio from ElevenLabs
     * @param {string} text - The text to speak
     * @param {string} voiceId - The ID of the voice to use
     * @returns {Promise<Stream>} - The audio stream
     */
    async streamAudio(text, voiceId) {
        if (!this.apiKey || this.apiKey.includes('PASTE_NEW_KEY')) {
            console.error("CRITICAL: ElevenLabs API Key is missing or default placeholder.");
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
                responseType: 'stream'
            });

            return response.data;

        } catch (error) {
            console.error("ElevenLabs API Error:", error.response?.status, JSON.stringify(error.response?.data || error.message));
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
