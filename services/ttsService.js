// services/ttsService.js
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        // CHANGED: Removed the hardcoded fallback. Now it relies 100% on Railway.
        this.apiKey = process.env.ELEVENLABS_API_KEY;
        
        if (!this.apiKey) {
            console.error("❌ CRITICAL: ELEVENLABS_API_KEY is missing from Environment Variables!");
        }

        // Initialize Cloudinary
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });

        console.log(`🎙️ TTS Service Ready (Cloudinary + ElevenLabs)`);
    }

    /**
     * Prepares text for the AI to read naturally.
     * Rules:
     * 1. Quotes: Say "quote" only at the START. Silent at the END.
     * 2. Dashes: Ignore them (replace with space).
     * 3. Colons: Treat as a full stop.
     */
    cleanTextForNews(text) {
        if (!text) return "";
        let clean = text;

        // 1. Handle Quotes (Toggle Logic)
        // We use a counter to know if we are opening or closing a quote.
        let quoteOpen = false;
        
        clean = clean.replace(/["“”]/g, (char) => {
            // Explicit Smart Quotes (if source uses them)
            if (char === '“') return " quote "; 
            if (char === '”') return "";        
            
            // Standard Straight Quotes (Toggle)
            if (!quoteOpen) {
                quoteOpen = true;
                return " quote "; // Open -> Say "quote"
            } else {
                quoteOpen = false;
                return "";        // Close -> Silent
            }
        });

        // 2. Handle Dashes: "Ignore" them (Replace with space)
        // Catches: Hyphen (-), En Dash (–), Em Dash (—)
        clean = clean.replace(/[-—–]/g, " ");

        // 3. Handle Colons: Force a full stop pause
        clean = clean.replace(/:/g, "."); 

        // 4. Normalize spaces (collapse multiple spaces created above)
        clean = clean.replace(/\s+/g, " ").trim();

        return clean;
    }

    async generateAndUpload(text, voiceId, articleId) {
        if (!this.apiKey) throw new Error("ElevenLabs API Key missing");

        // 1. Clean the text using our new rules
        const safeText = this.cleanTextForNews(text);
        
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        // Request Audio Stream
        const response = await axios.post(url, {
            text: safeText,
            model_id: "eleven_turbo_v2",
            voice_settings: {
                stability: 0.50,       // Balanced consistency
                similarity_boost: 0.75, // Stays true to the voice actor
                style: 0.35,           // Slight news-reading flair
                use_speaker_boost: true,
                speed: 0.90            // 90% speed for better clarity
            }
        }, {
            headers: {
                'xi-api-key': this.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            params: { optimize_streaming_latency: 3 },
            responseType: 'stream'
        });

        // 2. Upload Stream to Cloudinary
        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'the-gamut-audio',
                    public_id: `article_${articleId}`,
                    resource_type: 'video', 
                    format: 'mp3'
                },
                (error, result) => {
                    if (error) {
                        console.error("Cloudinary Upload Error:", error);
                        reject(error);
                    } else {
                        console.log(`✅ Audio Saved to Cloudinary: ${result.secure_url}`);
                        resolve(result.secure_url);
                    }
                }
            );

            response.data.pipe(uploadStream);
        });
    }
}

module.exports = new TTSService();
