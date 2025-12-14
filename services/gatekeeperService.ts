// services/gatekeeperService.ts
import axios from 'axios';
import KeyManager from '../utils/KeyManager';

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
    'horoscope', 'zodiac', 'tarot', 'astrology', 'retrograde', 'numerology',
    'lottery', 'winning numbers', 'powerball', 'mega millions', 'jackpot',
    
    // Spam / Clickbait / Adult
    'giveaway', 'sweepstakes', 'contest', 'sex position', 'porn', 'xxx', 'onlyfans',
    'watch live', 'live stream', 'how to watch', 'what time is', 'viral video',
    'caught on cam', 'shocking video', 'net worth',
    
    // Tech Troubleshooting / Errors
    '404', 'page not found', 'access denied', 'enable cookies'
];

class GatekeeperService {

    async evaluateArticle(article: any): Promise<{ category: string, type: 'Hard News' | 'Soft News' | 'Junk', isJunk: boolean, recommendedModel: string }> {
        // --- 1. Domain Check ---
        if (article.url) {
            const isBanned = BANNED_DOMAINS.some(domain => article.url.includes(domain));
            if (isBanned) {
                console.log(`🚫 Blocked by Blacklist: ${article.url}`);
                return { category: 'Junk', type: 'Junk', isJunk: true, recommendedModel: 'none' };
            }
        }

        // --- 2. Keyword Check ---
        const textToCheck = (article.title + " " + (article.description || "")).toLowerCase();
        const hasJunkKeyword = JUNK_KEYWORDS.some(keyword => textToCheck.includes(keyword));

        if (hasJunkKeyword) {
            console.log(`🗑️ Blocked by Keyword: ${article.title}`);
            return { category: 'Junk', type: 'Junk', isJunk: true, recommendedModel: 'none' };
        }

        // --- 3. AI Check (Final Filter) ---
        // Only use AI if it passes the cheap checks above
        try {
            const apiKey = await KeyManager.getKey('GEMINI');
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
            
            const prompt = `
            Analyze this news article metadata.
            Headline: "${article.title}"
            Description: "${article.description}"
            Source: "${article.source.name}"

            Task: Categorize it and Determine if it is "Hard News" (Politics, Economy, Conflict, Science, Major Events), "Soft News" (Entertainment, Sports, Lifestyle), or "Junk" (Clickbait, Spam, Shopping, Puzzles).
            
            Junk Categories: Shopping/Deals, Wordle/Game Guides, Horoscopes, Lottery Results, Viral Videos, Editorials/Opinions masquerading as news, Celebrity Gossip, Spam, 404/Error pages, Betting/Gambling, Stocks/Crypto Price Predictions, Sports Scores/Schedules.
            Respond ONLY in JSON: { "category": "String", "type": "Hard News" | "Soft News" | "Junk", "isJunk": boolean }`;

            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            }, { timeout: 10000 }); 

            KeyManager.reportSuccess(apiKey);

            const text = response.data.candidates[0].content.parts[0].text;
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            return {
                ...result,
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

        } catch (error: any) {
            const status = error.response?.status;
            const isRateLimit = status === 429;
            await KeyManager.reportFailure(await KeyManager.getKey('GEMINI'), isRateLimit);
            
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback: Assume Soft News if AI fails, don't discard blindly
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' };
        }
    }
}

export default new GatekeeperService();
