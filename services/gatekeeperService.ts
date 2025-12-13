// services/gatekeeperService.ts
import axios from 'axios';
import KeyManager from '../utils/KeyManager';

const MODEL_NAME = "gemini-2.5-flash"; 

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
    '404', 'page not found', 'access denied', 'forbidden', 'login', 'server down',
    'fix:', 'solved:', 'how to fix', 'error code', 'apk download',
    
    // Crypto/Financial Spam
    'presale', 'airdrop', 'price prediction', 'meme coin', 'pepe', 'shiba', 'doge',
    'crypto whale', 'x1000', 'bull run prediction',
    
    // Sports Specific (Scores/Schedules often lack narrative)
    'live score', 'box score', 'starting lineup', 'injury report', 'match preview',
    'vs.', 'highlights', 'full match'
];

// URLs containing these segments are often just media players or galleries
const JUNK_URL_SEGMENTS = [
    '/video/', '/watch/', '/gallery/', '/photos/', '/slideshow/', '/live-updates/'
];

interface IGatekeeperResult {
    category: string;
    type: 'Hard News' | 'Soft News' | 'Junk';
    isJunk: boolean;
    recommendedModel: string;
}

class GatekeeperService {
    constructor() {
        KeyManager.loadKeys('GEMINI', 'GEMINI');
    }

    isObviousJunk(article: any): boolean {
        const title = article.title || "";
        const url = article.url || "";
        
        if (!title) return true;
        if (title.length < 15) return true; // Too short to be a headline
        
        const lowerTitle = title.toLowerCase();
        const lowerUrl = url.toLowerCase();

        // 1. Check URL Structure
        if (JUNK_URL_SEGMENTS.some(seg => lowerUrl.includes(seg))) {
            return true;
        }
        
        // 2. Check Keywords
        const hasKeyword = JUNK_KEYWORDS.some(keyword => lowerTitle.includes(keyword));
        if (hasKeyword) return true;

        return false;
    }

    async evaluateArticle(article: any): Promise<IGatekeeperResult> {
        // --- STEP 1: Fast Static Check (Free) ---
        if (!article || !article.title) {
            return { category: 'Other', type: 'Soft News', isJunk: true, recommendedModel: 'gemini-2.5-flash' };
        }

        if (this.isObviousJunk(article)) {
            console.log(`🗑️ Pre-Filtered Junk: "${article.title.substring(0, 40)}..."`);
            return { category: 'Junk', type: 'Junk', isJunk: true, recommendedModel: 'gemini-2.5-flash' };
        }

        // --- STEP 2: AI Check (Cost) ---
        let apiKey = '';
        try {
            apiKey = await KeyManager.getKey('GEMINI');
            
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

            const prompt = `
            Task: Classify this news article based on its headline and description.
            Headline: "${article.title}"
            Description: "${article.description || ''}"
            Definitions:
            - [Hard News]: Politics, Global Conflict, Economy, Justice, Science, Tech, Health, Education, Environment.
            - [Soft News]: Sports, Entertainment, Lifestyle, Business, Human Interest, Travel, Food.
            - [Junk]: Shopping/Deals, Celebrity Gossip, Spam, 404/Error pages, Betting/Gambling, Stocks/Crypto Price Predictions, Sports Scores/Schedules.
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
            if (status === 429) {
                await KeyManager.reportFailure(apiKey, true);
            } else {
                await KeyManager.reportFailure(apiKey, false);
            }
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback: Assume Soft News if AI fails, don't discard blindly
            return { category: 'Other', type: 'Soft News', isJunk: false, recommendedModel: 'gemini-2.5-flash' }; 
        }
    }
}

export = new GatekeeperService();
