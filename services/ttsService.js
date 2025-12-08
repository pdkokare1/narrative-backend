// services/ttsService.js
const axios = require('axios');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class TTSService {
    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY;
    }

    /**
     * Streams audio from ElevenLabs
     * @param {string} text - The text to speak
     * @param {string} voiceId - The ID of the voice to use
     * @returns {Promise<Stream>} - The audio stream
     */
    async streamAudio(text, voiceId) {
        if (!this.apiKey) {
            throw new Error("Missing ELEVENLABS_API_KEY in server environment variables.");
        }

        const url = `${ELEVENLABS_API_URL}/${voiceId}/stream`;
        
        // Settings for stability vs expressiveness
        // optimize_streaming_latency: 0 (Default), 4 (Max speed)
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
            console.error("ElevenLabs API Error:", error.response?.status, error.message);
            throw new Error("Failed to generate speech");
        }
    }
}

module.exports = new TTSService();
