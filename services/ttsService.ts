// services/ttsService.ts
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import config from '../utils/config';
import logger from '../utils/logger';
import KeyManager from '../utils/KeyManager';
import CircuitBreaker from '../utils/CircuitBreaker';
import Article from '../models/articleModel'; // Added: To check for existing audio

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

class TTSService {
    constructor() {
        KeyManager.registerProviderKeys('ELEVENLABS', config.keys.elevenLabs);
        
        logger.info(`🎙️ TTS Service Initialized | Keys: ${config.keys.elevenLabs.length}`);

        // Cloudinary Init
        cloudinary.config({
            cloud_name: config.cloudinary.cloudName,
            api_key: config.cloudinary.apiKey,
            api_secret: config.cloudinary.apiSecret
        });
    }

    cleanTextForNews(text: string): string {
        if (!text) return "";
        let clean = text;

        // 1. Currency Fix
        clean = clean.replace(/\$([0-9\.,]+)\s?([mM]illion|[bB]illion|[tT]rillion)/gi, (match, num, magnitude) => {
            return `${num} ${magnitude} dollars`;
        });

        // 2. Quote Handling
        let quoteOpen = false;
        clean = clean.replace(/["“”]/g, (char) => {
            if (char === '“') return " quote "; 
            if (char === '”') return "";        
            if (!quoteOpen) { quoteOpen = true; return " quote "; } 
            else { quoteOpen = false; return ""; }
        });

        // 3. Punctuation Cleanup
        clean = clean.replace(/[-—–]/g, " ");
        clean = clean.replace(/:/g, ". . "); 
        clean = clean.replace(/\s+/g, " ").trim();

        return clean;
    }

    async generateAndUpload(text: string, voiceId: string, articleId: string | null, customFilename: string | null = null): Promise<string> {
        // --- IMPROVEMENT: DB CACHE CHECK ---
        // If we have an article ID, check if audio already exists.
        if (articleId) {
            try {
                const existingArticle = await Article.findById(articleId).select('audioUrl').lean();
                if (existingArticle && existingArticle.audioUrl) {
                    logger.info(`🎙️ Audio Cache Hit: Returning existing URL for ${articleId}`);
                    return existingArticle.audioUrl;
                }
            } catch (err) {
                logger.warn(`Audio Cache Check Failed (Non-fatal): ${err}`);
                // Continue to generation if DB check fails
            }
        }

        // 1. Check Circuit Breaker
        const isOpen = await CircuitBreaker.isOpen('ELEVENLABS');
        if (!isOpen) {
            throw new Error("CIRCUIT_BREAKER_OPEN: ElevenLabs is currently down or rate limited.");
        }

        let apiKey: string;
        try {
            apiKey = await KeyManager.getKey('ELEVENLABS');
        } catch (error: any) {
            logger.error(`TTS Key Error: ${error.message}`);
            throw error;
        }

        const safeText = this.cleanTextForNews(text);
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        logger.info(`🎙️ Generating Audio (HQ): "${customFilename || articleId}"`);

        try {
            const response = await axios.post(url, {
                text: safeText,
                model_id: "eleven_turbo_v2_5", // Keep v2.5 for speed/quality balance
                voice_settings: {
                    stability: 0.50,       
                    similarity_boost: 0.75, 
                    style: 0.35,           
                    use_speaker_boost: true,
                    speed: 1.0            
                }
            }, {
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                params: { optimize_streaming_latency: 3 },
                responseType: 'stream' 
            });

            // Report Success to KeyManager
            KeyManager.reportSuccess(apiKey);

            const publicId = customFilename ? customFilename : `article_${articleId}`;

            return new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'the-gamut-audio',
                        public_id: publicId,
                        resource_type: 'video', // 'video' allows audio in Cloudinary
                        format: 'mp3',
                        overwrite: true
                    },
                    (error, result) => {
                        if (error) {
                            logger.error(`❌ Cloudinary Upload Failed: ${error.message}`);
                            reject(error);
                        } else {
                            if (result && result.secure_url) {
                                logger.info(`✅ Upload Success: ${result.secure_url}`);
                                resolve(result.secure_url);
                            } else {
                                reject(new Error("Cloudinary upload successful but no URL returned."));
                            }
                        }
                    }
                );

                response.data.pipe(uploadStream);
                
                response.data.on('error', (err: any) => {
                    logger.error(`❌ Stream Error: ${err.message}`);
                    reject(err);
                });
            });

        } catch (error: any) {
            const status = error.response?.status;
            
            // Handle Quota/Auth Errors specifically
            if (status === 401 || status === 429) {
                logger.warn(`TTS Key Exhausted or Rate Limited (${status}). Reporting failure.`);
                await KeyManager.reportFailure(apiKey, true);
            } else if (status >= 500) {
                // Server error from ElevenLabs
                await CircuitBreaker.recordFailure('ELEVENLABS');
            }

            if (error.response) {
                throw new Error(`ElevenLabs API Error: ${status}`);
            } else {
                throw error;
            }
        }
    }
}

export default new TTSService();
