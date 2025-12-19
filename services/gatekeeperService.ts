// services/gatekeeperService.ts
import { jsonrepair } from 'jsonrepair';
import KeyManager from '../utils/KeyManager';
import redis from '../utils/redisClient'; 
import apiClient from '../utils/apiClient';
import logger from '../utils/logger';
import SystemConfig from '../models/systemConfigModel';
import { CONSTANTS, DEFAULT_BANNED_DOMAINS, JUNK_KEYWORDS } from '../utils/constants';

class GatekeeperService {
    private localKeywords: string[] = []; 

    /**
     * Initializes the DB with default values if missing AND syncs to Redis.
     */
    async initialize() {
        try {
            // 1. Sync Banned Domains (Mongo -> Redis)
            let bannedDoc = await SystemConfig.findOne({ key: 'BANNED_DOMAINS' });
            if (!bannedDoc) {
                logger.info('🛡️ Seeding Banned Domains...');
                bannedDoc = await SystemConfig.create({ key: 'BANNED_DOMAINS', value: DEFAULT_BANNED_DOMAINS });
            }
            
            if (redis.isReady() && bannedDoc.value.length > 0) {
                for (const domain of bannedDoc.value) {
                    await redis.sAdd(CONSTANTS.REDIS_KEYS.BANNED_DOMAINS, domain);
                }
            }

            // 2. Sync Keywords (Mongo -> Local Memory)
            let keywordsDoc = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            if (!keywordsDoc) {
                logger.info('🛡️ Seeding Junk Keywords...');
                keywordsDoc = await SystemConfig.create({ key: 'JUNK_KEYWORDS', value: JUNK_KEYWORDS });
            }
            this.localKeywords = keywordsDoc ? keywordsDoc.value : JUNK_KEYWORDS;
            
            logger.info(\`✅ Gatekeeper Config Loaded: \${this.localKeywords.length} keywords.\`);
        } catch (error) {
            logger.error('❌ Gatekeeper Init Failed:', error);
        }
    }

    private getDomain(url: string): string | null {
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace(/^www\\./, '');
        } catch (e) { return null; }
    }

    /**
     * LOCAL CHECK: Free and Fast.
     * Updated with stricter rules for efficiency.
     */
    private async quickLocalCheck(article: any): Promise<{ isJunk: boolean; reason?: string }> {
        const title = (article.title || "").trim();
        const titleLower = title.toLowerCase();
        const desc = (article.description || "").toLowerCase();
        const url = (article.url || "").toLowerCase();
        const domain = this.getDomain(url);

        // 1. Distributed Domain Check (Redis)
        if (domain && redis.isReady()) {
            const isBanned = await redis.sIsMember(CONSTANTS.REDIS_KEYS.BANNED_DOMAINS, domain);
            if (isBanned) return { isJunk: true, reason: 'Banned Domain (Redis)' };
        } 
        
        // 2. Keyword Check (Memory)
        const combinedText = \`\${titleLower} \${desc}\`;
        const foundKeyword = this.localKeywords.find(word => combinedText.includes(word));
        
        if (foundKeyword) {
            return { isJunk: true, reason: \`Keyword Match: "\${foundKeyword}"\` };
        }

        // 3. Length Check
        if ((title.length + desc.length) < 80) {
            return { isJunk: true, reason: 'Too Short / Empty' };
        }

        // 4. CAPS LOCK DETECTOR (New)
        // If more than 60% of the title is uppercase and title is long enough, it's likely spam/clickbait.
        const upperCount = title.replace(/[^A-Z]/g, "").length;
        if (title.length > 20 && (upperCount / title.length) > 0.6) {
             return { isJunk: true, reason: 'ALL CAPS TITLE' };
        }

        // 5. Excessive Emoji Detector (New)
        // Count typical emoji ranges or surrogate pairs
        const emojiCount = (title.match(/[\\u{1F300}-\\u{1F9FF}]/gu) || []).length;
        if (emojiCount > 2) {
             return { isJunk: true, reason: 'Excessive Emojis' };
        }

        return { isJunk: false };
    }

    private async handleJunkDetection(url: string) {
        const domain = this.getDomain(url);
        if (!domain || !redis.isReady()) return;

        try {
            const key = \`strikes:\${domain}\`;
            const strikes = await redis.incr(key);
            
            if (strikes === 1) await redis.expire(key, 86400 * 3); 

            if (strikes >= 5) {
                logger.warn(\`🚫 AUTO-BANNING DOMAIN: \${domain} (5 AI-Confirmed Junk Strikes)\`);
                await redis.sAdd(CONSTANTS.REDIS_KEYS.BANNED_DOMAINS, domain);
                await SystemConfig.findOneAndUpdate(
                    { key: 'BANNED_DOMAINS' },
                    { $addToSet: { value: domain } },
                    { upsert: true }
                );
                await redis.del(key);
            }
        } catch (e) { /* Ignore stats errors */ }
    }

    /**
     * FULL EVALUATION: Uses AI only if local check passes.
     */
    async evaluateArticle(article: any): Promise<{ type: string; isJunk: boolean; category?: string; recommendedModel: string }> {
        const CACHE_KEY = \`\${CONSTANTS.REDIS_KEYS.GATEKEEPER_CACHE}\${article.url}\`;
        
        // 1. Check Cache
        const cached = await redis.get(CACHE_KEY);
        if (cached) return cached;

        // 2. Run Local Check
        const localCheck = await this.quickLocalCheck(article);
        if (localCheck.isJunk) {
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            await redis.set(CACHE_KEY, result, 86400); 
            return result;
        }

        // 3. Run AI Check (Robust)
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            const prompt = \`
                Analyze this news article metadata.
                Headline: "\${article.title}"
                Description: "\${article.description}"
                
                Classify into one of these types:
                - "Hard News": Politics, Economy, War, Science, Major Crimes, Policy.
                - "Soft News": Entertainment, Sports, Lifestyle, Human Interest.
                - "Junk": Shopping, Ads, Game Guides, Horoscopes, pure clickbait.

                Respond ONLY in JSON: { "type": "Hard News" | "Soft News" | "Junk", "category": "String" }
            \`;

            // Use apiClient for better stability and timeout handling
            const url = \`https://generativelanguage.googleapis.com/v1beta/models/\${CONSTANTS.AI_MODELS.FAST}:generateContent?key=\${apiKey}\`;
            
            const response = await apiClient.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            }, { timeout: CONSTANTS.TIMEOUTS.EXTERNAL_API });

            KeyManager.reportSuccess(apiKey);

            const rawText = response.data.candidates[0].content.parts[0].text;
            
            // Robust Parsing with jsonrepair
            let result;
            try {
                result = JSON.parse(rawText);
            } catch (e) {
                result = JSON.parse(jsonrepair(rawText));
            }

            const isJunk = result.type === 'Junk';

            if (isJunk) {
                this.handleJunkDetection(article.url);
            }

            const finalDecision = {
                ...result,
                isJunk: isJunk,
                recommendedModel: result.type === 'Hard News' ? CONSTANTS.AI_MODELS.QUALITY : CONSTANTS.AI_MODELS.FAST
            };

            await redis.set(CACHE_KEY, finalDecision, 86400);
            return finalDecision;

        } catch (error: any) {
            const status = error.response?.status;
            try {
                const currentKey = await KeyManager.getKey('GEMINI'); 
                await KeyManager.reportFailure(currentKey, status === 429);
            } catch (e) { /* ignore */ }
            
            logger.error(\`Gatekeeper Error: \${error.message}\`);
            // Default to Soft News if AI fails, so we don't crash, but use FAST model next
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: CONSTANTS.AI_MODELS.FAST };
        }
    }
}

export default new GatekeeperService();
