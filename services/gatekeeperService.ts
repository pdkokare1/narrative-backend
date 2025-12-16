// services/gatekeeperService.ts
import axios from 'axios';
import KeyManager from '../utils/KeyManager';
import redis from '../utils/redisClient'; 
import SystemConfig from '../models/systemConfigModel';

const MODEL_NAME = "gemini-2.5-flash"; 

// --- 1. LOCAL BLOCKLISTS (Expanded for Cost Savings) ---
// These domains produce high-volume low-value content.
const DEFAULT_BANNED = [
    // Tabloids & Gossip
    'dailymail.co.uk', 'thesun.co.uk', 'nypost.com', 'tmz.com', 'perezhilton.com', 
    'mirror.co.uk', 'express.co.uk', 'dailystar.co.uk', 'radaronline.com',
    
    // Clickbait & Viral
    'buzzfeed.com', 'upworthy.com', 'viralnova.com', 'clickhole.com', 
    'ladbible.com', 'unilad.com', 'boredpanda.com',
    
    // Satire (AI gets confused by these)
    'theonion.com', 'babylonbee.com', 'duffelblog.com', 'newyorker.com/humor',
    
    // Propaganda / Extreme Bias (Optional - adjust as needed)
    'infowars.com', 'sputniknews.com', 'rt.com', 'breitbart.com', 'naturalnews.com',
    
    // Shopping / PR Wires
    'prweb.com', 'businesswire.com', 'prnewswire.com', 'globenewswire.com'
];

// These keywords flag an article as "Junk" instantly without AI analysis.
const DEFAULT_KEYWORDS = [
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'where to buy', 'restock', 'clearance',
    'bargain', 'doorbuster', 'cheapest',
    
    // Gaming Guides (Keep "Gaming News", block "Guides")
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'patch notes', 'loadout', 'tier list', 'how to get', 'where to find', 
    'twitch drops', 'codes for',
    
    // Fluff & Lifestyle
    'horoscope', 'zodiac', 'astrology', 'tarot', 'psychic', 'manifesting',
    'celeb look', 'red carpet', 'outfit', 'dress', 'fashion', 'makeup',
    'royal family', 'kardashian', 'jenner', 'relationship timeline', 'net worth',
    
    // Clickbait Phrases
    'watch:', 'video:', 'photos:', 'gallery:', 'live:', 'live updates', 
    'you need to know', 'here\'s why', 'what we know', 'everything we know',
    'reaction', 'reacts to', 'internet is losing it', 'fans are',
    
    // Gambling / Lottery
    'powerball', 'mega millions', 'lottery results', 'winning numbers', 
    'betting odds', 'prediction', 'parlay', 'gambling'
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
            
            // Push to Redis for global access (Set structure allows O(1) lookup)
            if (redis.isReady() && bannedDoc.value.length > 0) {
                for (const domain of bannedDoc.value) {
                    await redis.sAdd(this.REDIS_BANNED_KEY, domain);
                }
            }

            // 2. Sync Keywords (Mongo -> Local Memory)
            // Keywords are kept in memory because regex checking 100 words is faster than 100 Redis calls.
            let keywordsDoc = await SystemConfig.findOne({ key: 'JUNK_KEYWORDS' });
            if (!keywordsDoc) {
                console.log('🛡️ Seeding Junk Keywords...');
                keywordsDoc = await SystemConfig.create({ key: 'JUNK_KEYWORDS', value: DEFAULT_KEYWORDS });
            }
            this.localKeywords = keywordsDoc ? keywordsDoc.value : DEFAULT_KEYWORDS;
            
            console.log(`✅ Gatekeeper Config Loaded: ${this.localKeywords.length} keywords blocked locally.`);
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
        
        // 2. Keyword Check (Memory) - Check Title AND Description
        // We use a simple loop which is extremely fast for <1000 keywords
        const combinedText = `${title} ${desc}`;
        const foundKeyword = this.localKeywords.find(word => combinedText.includes(word));
        
        if (foundKeyword) {
            return { isJunk: true, reason: `Keyword Match: "${foundKeyword}"` };
        }

        // 3. Length Check (Too short usually means bad metadata or broken link)
        if ((title.length + desc.length) < 80) {
            return { isJunk: true, reason: 'Too Short / Empty' };
        }

        return { isJunk: false };
    }

    /**
     * AUTO BAN LOGIC:
     * If AI marks as junk repeatedly, we learn from it.
     * If strikes > 5, ban the domain GLOBALLY.
     */
    private async handleJunkDetection(url: string) {
        const domain = this.getDomain(url);
        if (!domain || !redis.isReady()) return;

        try {
            const key = `strikes:${domain}`;
            const strikes = await redis.incr(key);
            
            // Set expiry on first strike (3 days to get 5 strikes)
            if (strikes === 1) await redis.expire(key, 86400 * 3); 

            if (strikes >= 5) {
                console.warn(`🚫 AUTO-BANNING DOMAIN: ${domain} (5 AI-Confirmed Junk Strikes)`);
                
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
     * FULL EVALUATION: Uses AI only if local check passes.
     */
    async evaluateArticle(article: any): Promise<{ type: string; isJunk: boolean; category?: string; recommendedModel: string }> {
        const CACHE_KEY = `GATEKEEPER_DECISION_${article.url}`;
        
        // 1. Check Cache (Avoid re-processing same URL)
        const cached = await redis.get(CACHE_KEY);
        if (cached) return cached;

        // 2. Run Local "Zero-Cost" Check
        const localCheck = await this.quickLocalCheck(article);
        if (localCheck.isJunk) {
            console.log(`🚫 Gatekeeper Blocked: ${article.title.substring(0, 30)}... [${localCheck.reason}]`);
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            // Cache rejection for 24 hours so we don't check again
            await redis.set(CACHE_KEY, result, 86400); 
            return result;
        }

        // 3. Run AI Check (Costs Money) - Only for articles that passed local check
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            const prompt = `
                Analyze this news article metadata.
                Headline: "${article.title}"
                Description: "${article.description}"
                
                Classify into one of these types:
                - "Hard News": Politics, Economy, War, Science, Major Crimes, Policy, Global Events.
                - "Soft News": Entertainment, Sports, Lifestyle, Human Interest, Opinion, Reviews.
                - "Junk": Shopping, Ads, Game Guides, Horoscopes, minor viral videos, pure clickbait, lottery results.

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
                // If AI found junk that local check missed, record a strike against the domain
                this.handleJunkDetection(article.url);
            }

            const finalDecision = {
                ...result,
                isJunk: isJunk,
                // Use cheaper model for Soft News if we ever split models in future
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
            
            // Fallback: Assume Soft News (safe default to avoid blocking good news on error)
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' };
        }
    }
}

export default new GatekeeperService();
