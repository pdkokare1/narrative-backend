// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class TTSService {
    constructor() {
        // TEMP FIX: Hardcoded key since Railway login is blocked
        this.apiKey = 'sk_0aa52132b87eee3a27806a0a6bd788c6fdd089cbc385b7c4';
    }

    /**
     * Streams audio from ElevenLabs
     * @param {string} text - The text to speak
     * @param {string} voiceId - The ID of the voice to use
     * @returns {Promise<Stream>} - The audio stream
     */
    async streamAudio(text, voiceId) {
        // Fallback checks just in case
        if (!this.apiKey || this.apiKey.includes('placeholder')) {
            console.error("CRITICAL: ElevenLabs API Key is missing or invalid.");
            throw new Error("Server configuration error: Missing API Key");
        }

        const url = `${ELEVENLABS_API_URL}/${voiceId}/stream`;
        
        // Settings for stability vs expressiveness
        // optimize_streaming_latency: 3 (Max speed without quality drop)
        const params = {
            optimize_streaming_latency: 3 
        };

        const data = {
            text: text,
            model_id: "eleven_turbo_v2", // Turbo is cheaper and faster for news
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
                responseType: 'stream' // Crucial: We want the audio stream, not text
            });

            return response.data;

        } catch (error) {
            // Detailed error logging for debugging
            if (error.response) {
                console.error("ElevenLabs API Error:", error.response.status, JSON.stringify(error.response.data));
            } else {
                console.error("ElevenLabs Network Error:", error.message);
            }
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
