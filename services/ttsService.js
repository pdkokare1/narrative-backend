// services/ttsService.js
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY || 'sk_84859baaf9b9da27f81e79abd1d30827c8bf0ecb454b97aa';
        
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
        clean = clean.replace(/["“”]/g, " quote "); // Say "quote"
        clean = clean.replace(/[-—]/g, ", ");       // Pause for dashes
        clean = clean.replace(/:/g, ".");           // Pause for colons
        clean = clean.replace(/\s+/g, " ");         // Remove extra spaces
        return clean;
    }

    /**
     * GENERATE AND UPLOAD
     * 1. Calls ElevenLabs to get audio stream
     * 2. Pipes that stream directly to Cloudinary
     * 3. Returns the secure URL
     */
    async generateAndUpload(text, voiceId, articleId) {
        if (!this.apiKey) throw new Error("Missing ElevenLabs API Key");

        const safeText = this.cleanTextForNews(text);
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        // 1. Get Audio Stream from ElevenLabs
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
            responseType: 'stream' // Important: We get a stream, not a file
        });

        // 2. Upload Stream to Cloudinary
        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'the-gamut-audio', // Folder isolation
                    public_id: `article_${articleId}`, // Consistent naming
                    resource_type: 'video', // Cloudinary treats audio as 'video' type sometimes
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

            // Pipe ElevenLabs -> Cloudinary
            response.data.pipe(uploadStream);
        });
    }
}

module.exports = new TTSService();
