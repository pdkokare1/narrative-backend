// services/ttsService.js
const axios = require('axios');
const cloudinary = require('cloudinary').v2;

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY;
        
        // Log startup status (masked key)
        const keyStatus = this.apiKey ? `Present (${this.apiKey.slice(0,4)}...)` : 'MISSING';
        console.log(`🎙️ TTS Service Init | ElevenLabs Key: ${keyStatus}`);

        // Initialize Cloudinary
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });
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

    async generateAndUpload(text, voiceId, articleId, customFilename = null) {
        if (!this.apiKey) {
            throw new Error("ElevenLabs API Key is MISSING in Environment Variables.");
        }

        const safeText = this.cleanTextForNews(text);
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        console.log(`🎙️ Generating: "${customFilename || articleId}"...`);

        try {
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
                responseType: 'stream' // We expect a stream
            });

            // Determine filename
            const publicId = customFilename ? customFilename : `article_${articleId}`;

            // Upload to Cloudinary
            return new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'the-gamut-audio',
                        public_id: publicId,
                        resource_type: 'video', 
                        format: 'mp3',
                        overwrite: true
                    },
                    (error, result) => {
                        if (error) {
                            console.error("❌ Cloudinary Upload Failed:", error.message);
                            reject(error);
                        } else {
                            console.log(`✅ Upload Success: ${result.secure_url}`);
                            resolve(result.secure_url);
                        }
                    }
                );

                // Pipe the audio data to the upload stream
                response.data.pipe(uploadStream);
                
                // Handle stream errors
                response.data.on('error', (err) => {
                    console.error("❌ Stream Error:", err.message);
                    reject(err);
                });
            });

        } catch (error) {
            // Enhanced Error Logging
            if (error.response) {
                // If ElevenLabs returned an error (e.g. 401, 400), read the stream to see the message
                // Note: Since responseType is stream, we can't just read .data easily without buffering
                console.error(`❌ ElevenLabs API Error: ${error.response.status}`);
                throw new Error(`ElevenLabs API Error: ${error.response.status}`);
            } else {
                console.error("❌ Network/Unknown Error:", error.message);
                throw error;
            }
        }
    }
}

module.exports = new TTSService();
