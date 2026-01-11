// services/gatekeeperService.ts
import { jsonrepair } from 'jsonrepair';
import KeyManager from '../utils/KeyManager';
import redis from '../utils/redisClient'; 
import apiClient from '../utils/apiClient';
import logger from '../utils/logger';
import SystemConfig from '../models/systemConfigModel';
import { CONSTANTS, DEFAULT_BANNED_DOMAINS, JUNK_KEYWORDS, TRUSTED_SOURCES } from '../utils/constants';

class GatekeeperService {
    private localKeywords: string[] = []; 

    async initialize() {
        try {
            let bannedDoc = await SystemConfig.findOne({ key: 'BANNED_DOMAINS' });
            if (!bannedDoc) {
                bannedDoc = await SystemConfig.create({ key: 'BANNED_DOMAINS', value: DEFAULT_BANNED_DOMAINS });
            }
            
            if (redis.isReady() && bannedDoc.value.length > 0) {
                for (const domain of bannedDoc.value) {
                    await redis.sAdd(CONSTANTS.REDIS_KEYS.BANNED_DOMAINS, domain);
                }
            }

            let keywordsDoc = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            if (!keywordsDoc) {
                keywordsDoc = await SystemConfig.create({ key: 'JUNK_KEYWORDS', value: JUNK_KEYWORDS });
            }
            this.localKeywords = keywordsDoc ? keywordsDoc.value : JUNK_KEYWORDS;
            
            logger.info(`✅ Gatekeeper Config Loaded: ${this.localKeywords.length} keywords.`);
        } catch (error) {
            logger.error('❌ Gatekeeper Init Failed:', error);
        }
    }

    private getDomain(url: string): string | null {
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace(/^www\./, '');
        } catch (e) { return null; }
    }

    private async quickLocalCheck(article: any): Promise<{ isJunk: boolean; reason?: string }> {
        const titleRaw = article.title || article.headline || "";
        const descRaw = article.description || article.summary || article.content || "";

        const title = titleRaw.trim();
        const titleLower = title.toLowerCase();
        const desc = descRaw.toLowerCase();
        const url = (article.url || "").toLowerCase();
        const domain = this.getDomain(url);

        // 1. Distributed Domain Check (Redis)
        if (domain && redis.isReady()) {
            const isBanned = await redis.sIsMember(CONSTANTS.REDIS_KEYS.BANNED_DOMAINS, domain);
            if (isBanned) return { isJunk: true, reason: 'Banned Domain (Redis)' };
        } 
        
        // 2. Keyword Check (Memory)
        const combinedText = `${titleLower} ${desc}`;
        const foundKeyword = this.localKeywords.find(word => {
            return combinedText.includes(word);
        });
        
        if (foundKeyword) {
            return { isJunk: true, reason: `Keyword Match: "${foundKeyword}"` };
        }

        // 3. Length Check
        if ((title.length + desc.length) < 50) {
            return { isJunk: true, reason: 'Too Short / Empty' };
        }

        // 4. CAPS LOCK DETECTOR
        const upperCount = title.replace(/[^A-Z]/g, "").length;
        if (title.length > 20 && (upperCount / title.length) > 0.75) {
             return { isJunk: true, reason: 'ALL CAPS TITLE' };
        }

        return { isJunk: false };
    }

    private async handleJunkDetection(url: string) {
        const domain = this.getDomain(url);
        if (!domain || !redis.isReady()) return;

        try {
            const key = `strikes:${domain}`;
            const strikes = await redis.incr(key);
            
            if (strikes === 1) await redis.expire(key, 86400 * 3); 

            if (strikes >= 5) {
                logger.warn(`🚫 AUTO-BANNING DOMAIN: ${domain} (5 AI-Confirmed Junk Strikes)`);
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

    async evaluateArticle(article: any): Promise<{ type: string; isJunk: boolean; category?: string; recommendedModel: string; reason?: string }> {
        const CACHE_KEY = `${CONSTANTS.REDIS_KEYS.GATEKEEPER_CACHE}${article.url}`;
        
        const title = article.title || article.headline || "";
        const desc = article.description || article.summary || "";
        const sourceName = article.source || article.source?.name || "";

        // 1. Check Cache
        const cached = await redis.get(CACHE_KEY);
        if (cached) return cached;

        // 2. Run Local Check
        const localCheck = await this.quickLocalCheck(article);
        if (localCheck.isJunk) {
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none', reason: localCheck.reason };
            await redis.set(CACHE_KEY, result, 86400); 
            return result;
        }

        // OPTIMIZATION: VIP Fast Lane
        const isTrusted = TRUSTED_SOURCES.some(src => sourceName.toLowerCase().includes(src.toLowerCase()));
        if (isTrusted) {
            const result = { 
                type: 'Hard News', 
                isJunk: false, 
                recommendedModel: CONSTANTS.AI_MODELS.QUALITY,
                reason: 'Trusted Source (VIP)' 
            };
            await redis.set(CACHE_KEY, result, 86400);
            return result;
        }

        // 3. Run AI Check (Strict 70/30 Logic)
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            
            const prompt = `
                Analyze this news article metadata to determine if it is "Junk", "Soft News", or "Hard News".
                
                Headline: "${title}"
                Description: "${desc}"
                Source: "${sourceName}"
                
                DEFINITIONS:
                - "Hard News": Politics, Economy, Business, Finance, Markets, War, Disaster, Science, Technology, Policy, Major World Events, Royal/State Official Business.
                - "Soft News": Sports (Championships/Results only), Entertainment (Awards/Major Scandals only), Lifestyle.
                - "Junk": Rumors, Leaks, Speculation, Celebrity Sightings, Gossip, Dating Advice, Recipes, Shopping, Spam.

                CRITICAL RULES:
                1. REJECT (Classify as Junk): Any rumor, product leak, dating advice, diet tip, or minor celebrity sighting.
                2. REJECT: "Previews" or "Predictions". Only "Results" or "Happening Now" are news.
                3. ACCEPT Soft News ONLY if it is a major event (e.g., "Oscars Winners", "World Cup Final"). 
                4. ALL Political/Economic news is "Hard News".

                Respond ONLY in JSON: { "type": "Hard News" | "Soft News" | "Junk", "category": "String" }
            `;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONSTANTS.AI_MODELS.FAST}:generateContent?key=${apiKey}`;
            
            const response = await apiClient.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.0 }
            }, { timeout: CONSTANTS.TIMEOUTS.EXTERNAL_API });

            KeyManager.reportSuccess(apiKey);

            const rawText = response.data.candidates[0].content.parts[0].text;
            
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
                reason: isJunk ? 'AI Classified as Junk' : undefined,
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
            
            logger.error(`Gatekeeper Error: ${error.message}`);
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: CONSTANTS.AI_MODELS.FAST };
        }
    }
}

export default new GatekeeperService();
