// utils/promptManager.ts
import Prompt from '../models/aiPrompts';
import redis = require('./redisClient');
import logger = require('./logger');

const DEFAULT_ANALYSIS_PROMPT = `
Role: You are a Lead Editor for a global news wire.
Task: Rewrite the following story into a breaking news brief.

Input Article:
Headline: "{{headline}}"
Description: "{{description}}"
Snippet: "{{content}}"
Date: {{date}}

--- INSTRUCTIONS ---
1. Summarize (News Wire Style).
2. Categorize.
3. Assess Bias & Trust.
4. Extract Entities.

--- OUTPUT FORMAT ---
Respond ONLY in valid JSON.
`;

class PromptManager {
    
    async getTemplate(type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION' = 'ANALYSIS'): Promise<string> {
        const CACHE_KEY = `PROMPT_${type}`;

        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return cached;
        } catch (e) { /* Ignore Redis error */ }

        try {
            const doc = await Prompt.findOne({ type, active: true }).sort({ version: -1 }).lean();
            if (doc && doc.text) {
                await redis.set(CACHE_KEY, doc.text, 600); 
                return doc.text;
            }
        } catch (e: any) {
            logger.warn(`⚠️ Prompt DB Fetch failed: ${e.message}`);
        }

        return DEFAULT_ANALYSIS_PROMPT;
    }

    private interpolate(template: string, data: Record<string, string>): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    public async getAnalysisPrompt(article: any): Promise<string> {
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

export = new PromptManager();
