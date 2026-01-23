// narrative-backend/services/ttsService.ts
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import config from '../utils/config';
import logger from '../utils/logger';
import KeyManager from '../utils/KeyManager';
import CircuitBreaker from '../utils/CircuitBreaker';
import Article from '../models/articleModel';
import SystemConfig from '../models/systemConfigModel';
import redis from '../utils/redisClient'; // Make sure redisClient is available

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

    /**
     * Helper: Fetch TTS Correction Rules from DB
     */
    private async getTTSRules(): Promise<Array<{pattern: string, flags: string, replacement: string}>> {
        try {
            // Cache Check
            const cached = await redis.get('CONFIG_TTS_RULES');
            if (cached) return JSON.parse(cached);

            const conf = await SystemConfig.findOne({ key: 'tts_rules' });
            if (conf && Array.isArray(conf.value)) {
                await redis.set('CONFIG_TTS_RULES', JSON.stringify(conf.value), 600);
                return conf.value;
            }
        } catch (e) { /* Fallback */ }

        // Default Rules if DB is empty
        return [
            { pattern: "\\$([0-9\\.,]+)\\s?([mM]illion|[bB]illion|[tT]rillion)", flags: "gi", replacement: "$1 $2 dollars" },
            { pattern: "[-—–]", flags: "g", replacement: " " },
            { pattern: ":", flags: "g", replacement: ". . " },
            { pattern: "\\s+", flags: "g", replacement: " " }
        ];
    }

    async cleanTextForNews(text: string): Promise<string> {
        if (!text) return "";
        let clean = text;

        const rules = await this.getTTSRules();

        // Quote Handling (Hardcoded logic for "quote/unquote" behavior is safer in code, but simple replacement is config)
        let quoteOpen = false;
        clean = clean.replace(/["“”]/g, (char) => {
            if (char === '“') return " quote "; 
            if (char === '”') return "";        
            if (!quoteOpen) { quoteOpen = true; return " quote "; } 
            else { quoteOpen = false; return ""; }
        });

        // Apply Configurable Rules
        for (const rule of rules) {
            try {
                const regex = new RegExp(rule.pattern, rule.flags);
                clean = clean.replace(regex, (match, ...args) => {
                    // Handle $1, $2 replacement manually if needed, or rely on String.replace behavior
                    // Simple string replacement:
                    if (!rule.replacement.includes('$')) return rule.replacement;
                    
                    // Complex capture group replacement (e.g. $1 million)
                    let result = rule.replacement;
                    // args contains [p1, p2, offset, string]
                    // We only care about captures
                    const captures = args.slice(0, args.length - 2); 
                    captures.forEach((cap, idx) => {
                        result = result.replace(`$${idx + 1}`, cap);
                    });
                    return result;
                });
            } catch (e) {
                logger.warn(`Invalid TTS Regex in Config: ${rule.pattern}`);
            }
        }

        return clean.trim();
    }

    async generateAndUpload(
        text: string, 
        voiceId: string, 
        articleId: string | null, 
        customFilename: string | null = null,
        highQuality: boolean = false
    ): Promise<string> {
        
        if (articleId) {
            try {
                const existingArticle = await Article.findById(articleId).select('audioUrl').lean();
                if (existingArticle && existingArticle.audioUrl) {
                    return existingArticle.audioUrl;
                }
            } catch (err) { }
        }

        const isOpen = await CircuitBreaker.isOpen('ELEVENLABS');
        if (!isOpen) throw new Error("CIRCUIT_BREAKER_OPEN");

        let apiKey = await KeyManager.getKey('ELEVENLABS');
        const safeText = await this.cleanTextForNews(text); // UPDATED to await
        const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

        const modelId = highQuality ? "eleven_multilingual_v2" : "eleven_turbo_v2_5";
        const latencyOptimization = highQuality ? 0 : 3;
        
        try {
            const response = await axios.post(url, {
                text: safeText,
                model_id: modelId, 
                voice_settings: {
                    stability: highQuality ? 0.65 : 0.50,       
                    similarity_boost: 0.75, 
                    style: highQuality ? 0.45 : 0.35,           
                    use_speaker_boost: true,
                    speed: 1.0            
                }
            }, {
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                params: { optimize_streaming_latency: latencyOptimization },
                responseType: 'stream' 
            });

            KeyManager.reportSuccess(apiKey);

            const publicId = customFilename ? customFilename : `article_${articleId}`;

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
                            reject(error);
                        } else {
                            if (result && result.secure_url) {
                                resolve(result.secure_url);
                            } else {
                                reject(new Error("Cloudinary upload successful but no URL returned."));
                            }
                        }
                    }
                );
                response.data.pipe(uploadStream);
                response.data.on('error', (err: any) => reject(err));
            });

        } catch (error: any) {
            const status = error.response?.status;
            if (status === 401 || status === 429) {
                await KeyManager.reportFailure(apiKey, true);
            } else if (status >= 500) {
                await CircuitBreaker.recordFailure('ELEVENLABS');
            }
            throw error;
        }
    }
}

export default new TTSService();
