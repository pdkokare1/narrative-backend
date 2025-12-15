// services/gatekeeperService.ts
import axios from 'axios';
import KeyManager from '../utils/KeyManager';
import redis from '../utils/redisClient'; 
import SystemConfig from '../models/systemConfigModel';

const MODEL_NAME = "gemini-2.5-flash"; 

// --- INITIAL SEEDS (Used only if DB is empty) ---
const DEFAULT_BANNED = [
    'dailymail.co.uk', 'thesun.co.uk', 'nypost.com', 'breitbart.com', 
    'infowars.com', 'sputniknews.com', 'rt.com', 'tmz.com', 
    'perezhilton.com', 'gawker.com', 'buzzfeed.com', 'upworthy.com',
    'viralnova.com', 'clickhole.com', 'theonion.com', 'babylonbee.com'
];

const DEFAULT_KEYWORDS = [
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'hands-on:', 'where to buy', 'restock',
    'review:', 'deal:', 'bargain', 'clearance',
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'gameplay', 'patch notes', 'twitch', 'discord',
    'horoscope', 'zodiac', 'astrology', 'tarot', 'psychic', 'manifesting',
    'celeb look', 'red carpet', 'outfit', 'dress', 'fashion', 'makeup',
    'watch:', 'video:', 'photos:', 'gallery:', 'live:', 'live updates', 
    'you need to know', 'here\'s why', 'what we know', 'everything we know'
];

class GatekeeperService {
    private localKeywords: string[] = []; // Keep keywords local for speed (regex is fast)
    private readonly REDIS_BANNED_KEY = 'GATEKEEPER:BANNED_DOMAINS';

    /**
     * Initializes the DB with default values if missing AND syncs to Redis.
     */
    async initialize() {
        try {
            // 1. Sync Banned Domains (Mongo -> Redis)
            let bannedDoc = await SystemConfig.findOne({ key: 'BANNED_DOMAINS' });
            if (!bannedDoc) {
                console.log('🛡️ Seeding Banned Domains...');
                bannedDoc = await SystemConfig.create({ key: 'BANNED_DOMAINS', value: DEFAULT_BANNED });
            }
            
            // Push to Redis for global access
            if (redis.isReady() && bannedDoc.value.length > 0) {
                for (const domain of bannedDoc.value) {
                    await redis.sAdd(this.REDIS_BANNED_KEY, domain);
                }
            }

            // 2. Sync Keywords (Mongo -> Local Memory)
            let keywordsDoc = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            if (!keywordsDoc) {
                console.log('🛡️ Seeding Junk Keywords...');
                keywordsDoc = await SystemConfig.create({ key: 'JUNK_KEYWORDS', value: DEFAULT_KEYWORDS });
            }
            this.localKeywords = keywordsDoc ? keywordsDoc.value : DEFAULT_KEYWORDS;
            
            console.log('✅ Gatekeeper Config Loaded & Synced');
        } catch (error) {
            console.error('❌ Gatekeeper Init Failed:', error);
        }
    }

    /**
     * Helper to extract domain from URL
     */
    private getDomain(url: string): string | null {
        try {
            const hostname = new URL(url).hostname;
            return hostname.replace(/^www\./, '');
        } catch (e) { return null; }
    }

    /**
     * LOCAL CHECK: Free and Fast.
     * Uses Redis for domains and Local Memory for keywords.
     */
    private async quickLocalCheck(article: any): Promise<{ isJunk: boolean; reason?: string }> {
        const title = (article.title || "").toLowerCase();
        const desc = (article.description || "").toLowerCase();
        const url = (article.url || "").toLowerCase();
        const domain = this.getDomain(url);

        // 1. Distributed Domain Check (Redis)
        if (domain && redis.isReady()) {
            const isBanned = await redis.sIsMember(this.REDIS_BANNED_KEY, domain);
            if (isBanned) return { isJunk: true, reason: 'Banned Domain (Redis)' };
        } 
        // Fallback to local default if Redis down (optional, keeping it simple here)

        // 2. Keyword Check (Memory)
        const foundKeyword = this.localKeywords.find(word => title.includes(word));
        if (foundKeyword) {
            return { isJunk: true, reason: `Keyword Match: ${foundKeyword}` };
        }

        // 3. Length Check
        if ((title.length + desc.length) < 80) {
            return { isJunk: true, reason: 'Too Short' };
        }

        return { isJunk: false };
    }

    /**
     * AUTO BAN LOGIC:
     * If AI marks as junk, increment strike counter in Redis.
     * If strikes > 5, ban the domain GLOBALLY.
     */
    private async handleJunkDetection(url: string) {
        const domain = this.getDomain(url);
        if (!domain || !redis.isReady()) return;

        try {
            const key = `strikes:${domain}`;
            const strikes = await redis.incr(key);
            
            if (strikes === 1) await redis.expire(key, 86400 * 3); // 3 Days to get 5 strikes

            if (strikes >= 5) {
                console.warn(`🚫 AUTO-BANNING DOMAIN: ${domain} (5 Junk Strikes)`);
                
                // 1. Add to Redis (Instant block for all servers)
                await redis.sAdd(this.REDIS_BANNED_KEY, domain);
                
                // 2. Persist to MongoDB (Long term storage)
                await SystemConfig.findOneAndUpdate(
                    { key: 'BANNED_DOMAINS' },
                    { $addToSet: { value: domain } },
                    { upsert: true }
                );
                
                // 3. Clear Redis counter
                await redis.del(key);
            }
        } catch (e) { /* Ignore stats errors */ }
    }

    /**
     * FULL EVALUATION: Uses AI if local check passes.
     */
    async evaluateArticle(article: any): Promise<{ type: string; isJunk: boolean; category?: string; recommendedModel: string }> {
        const CACHE_KEY = `GATEKEEPER_DECISION_${article.url}`;
        
        // 1. Check Cache
        const cached = await redis.get(CACHE_KEY);
        if (cached) return cached;

        // 2. Run Local "Zero-Cost" Check
        const localCheck = await this.quickLocalCheck(article);
        if (localCheck.isJunk) {
            console.log(`🚫 Gatekeeper Blocked: ${article.title.substring(0, 30)}... [${localCheck.reason}]`);
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            await redis.set(CACHE_KEY, result, 86400); // Cache rejection
            return result;
        }

        // 3. Run AI Check (Costs Money)
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            const prompt = `
                Analyze this news article metadata.
                Headline: "${article.title}"
                Description: "${article.description}"
                
                Classify into one of these types:
                - "Hard News": Politics, Economy, War, Science, Major Crimes, Policy.
                - "Soft News": Entertainment, Sports, Lifestyle, Human Interest, Opinion.
                - "Junk": Shopping, Ads, Wordle/Game Guides, Horoscopes, minor viral videos, pure clickbait.

                Respond ONLY in JSON: { "type": "Hard News" | "Soft News" | "Junk", "category": "String" }
            `;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
                }, { timeout: 10000 }
            ); 

            KeyManager.reportSuccess(apiKey);

            const text = response.data.candidates[0].content.parts[0].text;
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            const isJunk = result.type === 'Junk';

            if (isJunk) {
                this.handleJunkDetection(article.url);
            }

            const finalDecision = {
                ...result,
                isJunk: isJunk,
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

            await redis.set(CACHE_KEY, finalDecision, 86400);

            return finalDecision;

        } catch (error: any) {
            const status = error.response?.status;
            const isRateLimit = status === 429;
            try {
                const currentKey = await KeyManager.getKey('GEMINI'); 
                await KeyManager.reportFailure(currentKey, isRateLimit);
            } catch (e) { /* ignore */ }
            
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback: Assume Soft News (safe default)
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' };
        }
    }
}

export default new GatekeeperService();
