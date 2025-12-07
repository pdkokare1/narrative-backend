// services/gatekeeperService.js
const axios = require('axios');

// We use the 2.5 Flash model for high-speed categorization
const MODEL_NAME = "gemini-2.5-flash"; 

class GatekeeperService {
    constructor() {
        this.apiKeys = this.loadApiKeys();
        this.currentKeyIndex = 0;
    }

    loadApiKeys() {
        // We reuse the existing GEMINI keys from your .env file
        const keys = [];
        for (let i = 1; i <= 20; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
            if (key) keys.push(key);
        }
        const defaultKey = process.env.GEMINI_API_KEY?.trim();
        if (keys.length === 0 && defaultKey) keys.push(defaultKey);
        return keys;
    }

    getNextApiKey() {
        if (this.apiKeys.length === 0) throw new Error("No API Keys available for Gatekeeper");
        const key = this.apiKeys[this.currentKeyIndex];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        return key;
    }

    /**
     * The Gatekeeper Decision:
     * 1. Classifies the article into granular categories.
     * 2. Decides which model should analyze it (Pro vs Flash).
     * 3. Rejects junk (Shopping, Gossip, Spam).
     */
    async evaluateArticle(article) {
        // Safety check
        if (!article || !article.title) {
            return { category: 'Other', type: 'Soft News', isJunk: true };
        }

        const apiKey = this.getNextApiKey();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

        // Minimal prompt to save tokens and speed up response
        const prompt = `
        Task: Classify this news article based on its headline and description.
        
        Headline: "${article.title}"
        Description: "${article.description || ''}"
        
        Definitions:
        - [Hard News]: Politics, Global Conflict, Economy, Justice, Science, Tech, Health, Education. (Requires deep analysis)
        - [Soft News]: Sports, Entertainment, Lifestyle, Business, Human Interest. (Requires summary only)
        - [Junk]: Shopping/Deals, Celebrity Gossip, Spam, 404/Error pages.
        
        Respond ONLY in JSON format:
        {
            "category": "Specific Category Name",
            "type": "Hard News" | "Soft News" | "Junk",
            "isJunk": boolean
        }`;

        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { 
                    responseMimeType: "application/json", 
                    temperature: 0.1 // Low temperature for consistent categorization
                }
            }, { timeout: 10000 }); // Fast timeout (10s) because Flash is quick

            const text = response.data.candidates[0].content.parts[0].text;
            // Sanitize and parse JSON
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            return {
                ...result,
                // Assign the Model Recommendation based on type
                // Hard News -> Expensive Pro Model
                // Soft News -> Cheap Flash Model
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

        } catch (error) {
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            
            // Fallback Logic:
            // If the Gatekeeper fails (e.g., network glitch), we play it safe:
            // 1. Assume it is NOT junk (so we don't lose news).
            // 2. Default to Flash model to save costs on potential errors.
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
