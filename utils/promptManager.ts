// src/utils/promptManager.ts
import Prompt from '../models/aiPrompts';
import redis from './redisClient';
import logger from './logger';

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

const SUMMARY_ONLY_PROMPT = `
Role: You are a News Curator.
Task: Summarize this story concisely.

Input Article:
Headline: "{{headline}}"
Description: "{{description}}"
Snippet: "{{content}}"

--- INSTRUCTIONS ---
1. Summarize: Provide a 2-3 sentence factual summary.
2. Categorize: Choose the most relevant category (e.g., Entertainment, Sports, Lifestyle).
3. Sentiment: Determine if the story is Positive, Negative, or Neutral.

--- OUTPUT FORMAT ---
Respond ONLY in valid JSON:
{
  "summary": "String",
  "category": "String",
  "sentiment": "String",
  "politicalLean": "Not Applicable",
  "analysisType": "SentimentOnly"
}
`;

class PromptManager {
    
    async getTemplate(type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION' | 'SUMMARY_ONLY' = 'ANALYSIS'): Promise<string> {
        const CACHE_KEY = `PROMPT_${type}`;

        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return cached;
        } catch (e) { /* Ignore Redis error */ }

        // Fallback templates if DB is empty or fails
        if (type === 'SUMMARY_ONLY') return SUMMARY_ONLY_PROMPT;

        try {
            // @ts-ignore - DB model might not have SUMMARY_ONLY in enum yet, safe to cast or ignore
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

    public async getAnalysisPrompt(article: any, mode: 'Full' | 'Basic' = 'Full'): Promise<string> {
        // Choose template based on mode
        const templateType = mode === 'Basic' ? 'SUMMARY_ONLY' : 'ANALYSIS';
        const template = await this.getTemplate(templateType);
        
        const data = {
            headline: article.title || "No Title",
            description: article.description || "No Description",
            content: (article.content || "").substring(0, 500).replace(/\n/g, " "),
            date: new Date().toISOString().split('T')[0]
        };

        return this.interpolate(template, data);
    }
}

export default new PromptManager();
