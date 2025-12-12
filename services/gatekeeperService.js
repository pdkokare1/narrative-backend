// services/gatekeeperService.js
const axios = require('axios');
const KeyManager = require('../utils/KeyManager'); // <--- NEW: Central Manager

// We use the 2.5 Flash model for high-speed categorization
const MODEL_NAME = "gemini-2.5-flash"; 

// --- OPTIMIZATION: Extended Junk Keywords ---
const JUNK_KEYWORDS = [
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'review: ', 'hands-on:',
    
    // Puzzles & Gaming Help
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer',
    
    // Astrology & Gambling
    'horoscope', 'zodiac', 'tarot', 'astrology', 'retrograde',
    'lottery', 'winning numbers', 'powerball', 'mega millions', 'jackpot',
    
    // Clickbait / Low Quality
    'giveaway', 'sweepstakes', 'contest', 'sex position', 'porn', 'xxx',
    'watch live', 'live stream', 'how to watch', 'what time is',
    
    // System Errors
    '404', 'page not found', 'access denied', 'forbidden', 'login'
];

class GatekeeperService {
    constructor() {
        // 1. Initialize Keys via Manager (Reusing GEMINI keys)
        // Note: Gatekeeper uses the same pool as AI Service, which is fine.
        // If you want separate quotas, you could use a different prefix like 'GATEKEEPER'.
        KeyManager.loadKeys('GEMINI', 'GEMINI');
    }

    /**
     * Checks if the title contains obvious junk keywords.
     */
    isObviousJunk(title) {
        if (!title) return true;
        if (title.length < 15) return true; // Too short to be a valid news headline

        const lowerTitle = title.toLowerCase();
        
        // Check exact keyword matches
        return JUNK_KEYWORDS.some(keyword => lowerTitle.includes(keyword));
    }

    /**
     * The Gatekeeper Decision:
     * 1. CHEAP CHECK: Keyword filtering.
     * 2. SMART CHECK: AI Classification.
     */
    async evaluateArticle(article) {
        // Safety check
        if (!article || !article.title) {
            return { category: 'Other', type: 'Soft News', isJunk: true };
        }

        // --- 1. INSTANT REJECTION (Cost Saving) ---
        if (this.isObviousJunk(article.title)) {
            console.log(`🗑️ Pre-Filtered Junk: "${article.title.substring(0, 40)}..."`);
            return { category: 'Junk', type: 'Junk', isJunk: true };
        }

        // --- 2. AI EVALUATION ---
        let apiKey = '';
        try {
            // 2. Get Valid Key
            apiKey = KeyManager.getKey('GEMINI');
            
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

            const prompt = `
            Task: Classify this news article based on its headline and description.
            
            Headline: "${article.title}"
            Description: "${article.description || ''}"
            
            Definitions:
            - [Hard News]: Politics, Global Conflict, Economy, Justice, Science, Tech, Health, Education, Environment. (Requires deep analysis)
            - [Soft News]: Sports, Entertainment, Lifestyle, Business, Human Interest, Travel, Food. (Requires summary only)
            - [Junk]: Shopping/Deals, Celebrity Gossip, Spam, 404/Error pages, Betting/Gambling.
            
            Respond ONLY in JSON format:
            {
                "category": "Specific Category Name",
                "type": "Hard News" | "Soft News" | "Junk",
                "isJunk": boolean
            }`;

            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { 
                    responseMimeType: "application/json", 
                    temperature: 0.1 
                }
            }, { timeout: 10000 }); 

            // 3. Report Success
            KeyManager.reportSuccess(apiKey);

            const text = response.data.candidates[0].content.parts[0].text;
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            return {
                ...result,
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

        } catch (error) {
            // 4. Report Failure
            const status = error.response?.status;
            if (status === 429) {
                KeyManager.reportFailure(apiKey, true);
            } else {
                KeyManager.reportFailure(apiKey, false);
            }

            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback Logic
            return { 
                category: 'Other', 
                type: 'Soft News', 
                isJunk: false, 
                recommendedModel: 'gemini-2.5-flash' 
            }; 
        }
    }
}

module.exports = new GatekeeperService();
