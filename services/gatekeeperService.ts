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
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'hands-on:', 'where to buy', 'restock',
    'review:', 'deal:', 'bargain', 'clearance',
    
    // Games & Puzzles
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'gameplay', 'patch notes', 'twitch', 'discord',
    
    // Astrology & Fluff
    'horoscope', 'zodiac', 'astrology', 'tarot', 'psychic', 'manifesting',
    'celeb look', 'red carpet', 'outfit', 'dress', 'fashion', 'makeup',
    
    // Clickbait Specifics
    'watch:', 'video:', 'photos:', 'gallery:', 'live:', 'live updates', 
    'you need to know', 'here\'s why', 'what we know', 'everything we know'
];

class GatekeeperService {
    private localCache: { banned: string[]; keywords: string[] } = { banned: [], keywords: [] };
    private lastFetch: number = 0;
    private readonly REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

    /**
     * Initializes the DB with default values if missing.
     */
    async initialize() {
        try {
            const bannedDoc = await SystemConfig.findOne({ key: 'BANNED_DOMAINS' });
            if (!bannedDoc) {
                console.log('🛡️ Seeding Banned Domains...');
                await SystemConfig.create({ key: 'BANNED_DOMAINS', value: DEFAULT_BANNED });
            }

            const keywordsDoc = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            if (!keywordsDoc) {
                console.log('🛡️ Seeding Junk Keywords...');
                await SystemConfig.create({ key: 'JUNK_KEYWORDS', value: DEFAULT_KEYWORDS });
            }
            
            // Initial load
            await this.refreshConfig();
            console.log('✅ Gatekeeper Config Loaded');
        } catch (error) {
            console.error('❌ Gatekeeper Init Failed:', error);
        }
    }

    /**
     * Refreshes the local cache from the Database
     */
    private async refreshConfig() {
        try {
            const banned = await SystemConfig.findOne({ key: 'BANNED_DOMAINS' });
            const keywords = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            
            if (banned) this.localCache.banned = banned.value;
            if (keywords) this.localCache.keywords = keywords.value;
            
            this.lastFetch = Date.now();
        } catch (e) { /* silent fail, use old cache */ }
    }

    /**
     * LOCAL CHECK: Free and Fast.
     * Uses DB-backed configuration.
     */
    private async quickLocalCheck(article: any): Promise<{ isJunk: boolean; reason?: string }> {
        // Refresh cache if stale
        if (Date.now() - this.lastFetch > this.REFRESH_INTERVAL) {
            await this.refreshConfig();
        }

        const title = (article.title || "").toLowerCase();
        const desc = (article.description || "").toLowerCase();
        const url = (article.url || "").toLowerCase();

        // 1. Domain Check
        if (this.localCache.banned.some(domain => url.includes(domain))) {
            return { isJunk: true, reason: 'Banned Domain' };
        }

        // 2. Keyword Check
        const foundKeyword = this.localCache.keywords.find(word => title.includes(word));
        if (foundKeyword) {
            return { isJunk: true, reason: `Keyword Match: ${foundKeyword}` };
        }

        // 3. Length Check (Too short usually means bad metadata)
        if ((title.length + desc.length) < 80) {
            return { isJunk: true, reason: 'Too Short' };
        }

        return { isJunk: false };
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
            console.log(`🚫 Gatekeeper Blocked (Local): ${article.title.substring(0, 30)}... [${localCheck.reason}]`);
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            await this.cacheResult(CACHE_KEY, result, 86400); // Cache rejection for 24h
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

            const finalDecision = {
                ...result,
                isJunk: result.type === 'Junk',
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

            // Cache the AI's decision
            await this.cacheResult(CACHE_KEY, finalDecision, 86400);

            return finalDecision;

        } catch (error: any) {
            const status = error.response?.status;
            const isRateLimit = status === 429;
            await KeyManager.reportFailure(await KeyManager.getKey('GEMINI'), isRateLimit);
            
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback: Assume Soft News if AI fails (don't discard potential news)
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' };
        }
    }

    // Helper to save to Redis safely
    private async cacheResult(key: string, data: any, ttl: number = 86400) {
        try {
            await redis.set(key, data, ttl);
        } catch (e) { /* Ignore cache errors */ }
    }
}

export default new GatekeeperService();
