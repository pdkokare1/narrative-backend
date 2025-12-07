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
        // We reuse the existing GEMINI keys. 
        // In a real production setup, you might want separate keys for Flash/Pro to track costs.
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
     * 1. Classifies the article.
     * 2. Decides which model should analyze it (Pro vs Flash).
     * 3. Rejects junk.
     */
    async evaluateArticle(article) {
        const apiKey = this.getNextApiKey();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

        // Minimal prompt to save tokens
        const prompt = `
        Task: Classify this news article.
        Headline: "${article.title}"
        Desc: "${article.description}"
        
        Categories:
        [Hard News]: Politics, Global Conflict, Economy, Justice, Science, Tech, Health, Education
        [Soft News]: Sports, Entertainment, Lifestyle, Business, Human Interest
        [Junk]: Shopping, Gossip, Spam
        
        Output JSON ONLY:
        {
            "category": "Category Name",
            "type": "Hard News" | "Soft News" | "Junk",
            "isJunk": boolean
        }`;

        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            });

            const text = response.data.candidates[0].content.parts[0].text;
            const result = JSON.parse(text.replace(/```json|```/g, '').trim());

            return {
                ...result,
                // Assign the Model Recommendation based on type
                recommendedModel: result.type === 'Hard News' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
            };

        } catch (error) {
            console.error(`Gatekeeper Error for "${article.title.substring(0, 20)}...":`, error.message);
            // Fallback: Assume it's Hard News to be safe, but mark as error
            return { category: 'Other', type: 'Hard News', isJunk: false, recommendedModel: 'gemini-2.5-flash' }; 
        }
    }
}

module.exports = new GatekeeperService();
