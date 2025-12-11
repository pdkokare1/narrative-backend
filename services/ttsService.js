// services/ttsService.js
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
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

    cleanTextForNews(text) {
        if (!text) return "";
        let clean = text;
        
        let quoteOpen = false;
        clean = clean.replace(/["“”]/g, (char) => {
            if (char === '“') return " quote "; 
            if (char === '”') return "";        
            if (!quoteOpen) { quoteOpen = true; return " quote "; } 
            else { quoteOpen = false; return ""; }
        });

        clean = clean.replace(/[-—–]/g, " ");
        clean = clean.replace(/:/g, "."); 
        clean = clean.replace(/\s+/g, " ").trim();

        return clean;
    }

    // UPDATED: Now accepts customFilename
    async generateAndUpload(text, voiceId, articleId, customFilename = null) {
        if (!this.apiKey) throw new Error("ElevenLabs API Key missing");

        const safeText = this.cleanTextForNews(text);
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        const response = await axios.post(url, {
            text: safeText,
            model_id: "eleven_turbo_v2",
            voice_settings: {
                stability: 0.50,       
                similarity_boost: 0.75, 
                style: 0.35,           
                use_speaker_boost: true,
                speed: 0.90            
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

        // Determine the Public ID (Filename) in Cloudinary
        // If customFilename is provided, use it. Otherwise use article_{id}
        const publicId = customFilename ? customFilename : `article_${articleId}`;

        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'the-gamut-audio',
                    public_id: publicId,
                    resource_type: 'video', 
                    format: 'mp3',
                    overwrite: true // Allow overwriting if we regenerate
                },
                (error, result) => {
                    if (error) {
                        console.error("Cloudinary Upload Error:", error);
                        reject(error);
                    } else {
                        console.log(`✅ Audio Saved: ${publicId}`);
                        resolve(result.secure_url);
                    }
                }
            );

            response.data.pipe(uploadStream);
        });
    }
}

module.exports = new TTSService();
