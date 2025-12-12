// utils/promptManager.js
const Prompt = require('../models/promptModel');
const redis = require('./redisClient');
const logger = require('./logger');

// --- DEFAULT HARDCODED PROMPT (Fallback) ---
// This ensures the system works even if the DB is empty.
const DEFAULT_ANALYSIS_PROMPT = `
Role: You are a Lead Editor for a global news wire.
Task: Rewrite the following story into a breaking news brief.

Input Article:
Headline: "{{headline}}"
Description: "{{description}}"
Snippet: "{{content}}"
Date: {{date}}

--- INSTRUCTIONS ---
1. **Summarize (News Wire Style)**:
   - Direct reporting. No "The article says".
   - Use exact titles (e.g., "President", "Former President") as they appear in text.
   - Length: ~75 words.
   - Tone: Objective, authoritative, direct.

2. **Categorize**:
   - Choose ONE: Politics, Business, Economy, Global Conflict, Tech, Science, Health, Justice, Sports, Entertainment, Lifestyle, Crypto & Finance, Gaming.

3. **Assess Bias & Trust**:
   - Bias Score (0-100).
   - Trust Score (0-100).

4. **Extract Entities**:
   - Primary Noun (Subject).
   - Secondary Noun (Context).

--- OUTPUT FORMAT ---
Respond ONLY in valid JSON.
{
  "summary": "Direct news brief.",
  "category": "CategoryString",
  "politicalLean": "Center",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "clusterTopic": "Event Name",
  "country": "Global",
  "primaryNoun": "Subject",
  "secondaryNoun": "Context",
  "biasScore": 0, "biasLabel": "Label",
  "biasComponents": { "linguistic": {}, "sourceSelection": {}, "demographic": {}, "framing": {} },
  "credibilityScore": 0, "credibilityGrade": "N/A",
  "credibilityComponents": {},
  "reliabilityScore": 0, "reliabilityGrade": "N/A",
  "reliabilityComponents": {},
  "trustLevel": "Medium",
  "keyFindings": [],
  "recommendations": []
}`;

class PromptManager {
    
    // --- 1. Fetch Logic (Cache -> DB -> Fallback) ---
    async getTemplate(type = 'ANALYSIS') {
        const CACHE_KEY = `PROMPT_${type}`;

        // A. Try Redis
        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return cached;
        } catch (e) {
            // Redis failure shouldn't stop us
        }

        // B. Try MongoDB
        try {
            const doc = await Prompt.findOne({ type, active: true }).sort({ version: -1 }).lean();
            if (doc && doc.text) {
                // Cache for 10 minutes
                await redis.set(CACHE_KEY, doc.text, 600); 
                return doc.text;
            }
        } catch (e) {
            logger.warn(`⚠️ Prompt DB Fetch failed: ${e.message}`);
        }

        // C. Fallback
        return DEFAULT_ANALYSIS_PROMPT;
    }

    // --- 2. Interpolation Logic ---
    // Replaces {{variable}} with actual data
    interpolate(template, data) {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    // --- 3. Public Method ---
    async getAnalysisPrompt(article) {
        const template = await this.getTemplate('ANALYSIS');
        
        const data = {
            headline: article.title || "No Title",
            description: article.description || "No Description",
            content: (article.content || "").substring(0, 500).replace(/\n/g, " "),
            date: new Date().toISOString().split('T')[0]
        };

        return this.interpolate(template, data);
    }
}

module.exports = new PromptManager();
