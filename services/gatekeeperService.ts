// services/gatekeeperService.ts
import axios from 'axios';
import KeyManager from '../utils/KeyManager';
import redis from '../utils/redisClient'; // Import Redis

const MODEL_NAME = "gemini-2.5-flash"; 

// --- 1. BLACKLIST ---
const BANNED_DOMAINS = [
    'dailymail.co.uk', 'thesun.co.uk', 'nypost.com', 'breitbart.com', 
    'infowars.com', 'sputniknews.com', 'rt.com', 'tmz.com', 
    'perezhilton.com', 'gawker.com', 'buzzfeed.com', 'upworthy.com',
    'viralnova.com', 'clickhole.com', 'theonion.com', 'babylonbee.com'
];

const JUNK_KEYWORDS = [
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'hands-on:', 'where to buy', 'restock',
    'review:', 'deal:', 'bargain', 'clearance',
    
    // Games & Puzzles
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'gameplay', 'patch notes', 'twitch', 'discord',
    
    // Astrology & Luck
    'horoscope', 'zodiac', 'tarot', 'astrology', 'lucky number', 'lottery result', 'winning numbers',
    
    // Clickbait / Gossip
    'you won\'t believe', 'shocking', 'celeb', 'gossip', 'rumor', 'spotted', 'red carpet',
    'viral video', 'watch:', 'must see', 'caught on camera', 'net worth'
];

class GatekeeperService {

    async evaluateArticle(article: any): Promise<{ type: string; isJunk: boolean; recommendedModel: string; category?: string }> {
        const url = article.url || '';
        const title = (article.title || '').toLowerCase();
        
        // --- STEP 1: CACHE CHECK (Cost Saver) ---
        // If we processed this URL recently, return the cached verdict.
        const CACHE_KEY = `gatekeeper:${Buffer.from(url).toString('base64')}`; // Safe key
        try {
            const cachedResult = await redis.get(CACHE_KEY);
            if (cachedResult) {
                // console.log(`🛡️ Gatekeeper Cache Hit: ${url.substring(0, 30)}...`);
                return cachedResult; // Return the saved JSON object
            }
        } catch (e) { /* Ignore Redis errors */ }

        // --- STEP 2: STATIC CHECKS ---
        // A. Domain Block
        if (BANNED_DOMAINS.some(domain => url.includes(domain))) {
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            await this.cacheResult(CACHE_KEY, result);
            return result;
        }

        // B. Keyword Block
        if (JUNK_KEYWORDS.some(kw => title.includes(kw))) {
            const result = { type: 'Junk', isJunk: true, recommendedModel: 'none' };
            await this.cacheResult(CACHE_KEY, result);
            return result;
        }

        // --- STEP 3: AI EVALUATION ---
        // Only ask AI if it passes the basic filters
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

            const prompt = `
            Analyze this article for a serious news app.
            
            Headline: "${article.title}"
            Description: "${article.description || ''}"
            Source: "${article.source?.name || ''}"
            
            Classify into:
            1. "Hard News": Politics, Economy, Conflict, Science, Major Tech, Climate.
            2. "Soft News": Entertainment, Sports, Lifestyle, Human Interest, Reviews.
            3. "Junk": Clickbait, Editorials/Opinions masquerading as news, Celebrity Gossip, Spam, 404/Error pages, Betting/Gambling, Stocks/Crypto Price Predictions, Sports Scores/Schedules.
            Respond ONLY in JSON: { "category": "String", "type": "Hard News" | "Soft News" | "Junk", "isJunk": boolean }`;

            const response = await axios.post(apiUrl, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            }, { timeout: 10000 }); 

            KeyManager.reportSuccess(apiKey);

            const text = response.data.candidates[0].content.parts[0].text;
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            const finalDecision = {
                ...result,
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

            // Cache the AI's decision for 24 hours (86400 seconds)
            await this.cacheResult(CACHE_KEY, finalDecision, 86400);

            return finalDecision;

        } catch (error: any) {
            const status = error.response?.status;
            const isRateLimit = status === 429;
            await KeyManager.reportFailure(await KeyManager.getKey('GEMINI'), isRateLimit);
            
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback: Assume Soft News if AI fails, don't discard blindly
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' };
        }
    }

    // Helper to save to Redis safely
    private async cacheResult(key: string, data: any, ttl: number = 86400) {
        try {
            await redis.set(key, data, ttl);
        } catch (e) {
            console.warn("Gatekeeper Cache Write Failed");
        }
    }
}

export default new GatekeeperService();
