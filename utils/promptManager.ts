// src/utils/promptManager.ts
import Prompt from '../models/aiPrompts';
import redis from './redisClient';
import logger from './logger';

// --- RICH DEFAULT PROMPTS (Merged from utils/prompts.ts) ---

const AI_PERSONALITY = {
    MAX_WORDS: 75, 
    TONE: "Objective, authoritative, and direct (News Wire Style)",
    BIAS_STRICTNESS: "Strict. Flag subtle framing, omission, and emotional language.",
    FORBIDDEN_WORDS: "delves, underscores, crucial, tapestry, landscape, moreover, notably, the article, the report, the author, discusses, highlights, according to"
};

const STYLE_RULES = `
Style Guidelines:
- **DIRECT REPORTING:** Act as the primary source. Do NOT say "The article states" or "The report highlights." Just state the facts.
- **TITLE ACCURACY:** Use the EXACT titles found in the source text.
- Tone: ${AI_PERSONALITY.TONE}.
- Length: Around ${AI_PERSONALITY.MAX_WORDS} words.
- Structure: Use short, punchy sentences suitable for audio reading.
- Grammar: Do NOT use hyphens (-), dashes (—), or colons (:) within sentences. Use periods or commas.
- Vocabulary: Do NOT use these words: ${AI_PERSONALITY.FORBIDDEN_WORDS}.
`;

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
   ${STYLE_RULES}
   - Report the "Who, What, When, Where, Why" immediately.

2. **Categorize**:
   - Choose ONE: Politics, Business, Economy, Global Conflict, Tech, Science, Health, Justice, Sports, Entertainment, Lifestyle, Crypto & Finance, Gaming.

3. **Assess Bias & Trust (${AI_PERSONALITY.BIAS_STRICTNESS})**:
   - Political Lean: Left, Left-Leaning, Center, Right-Leaning, Right.
   - Bias Score (0-100): 0 = Neutral, 100 = Propaganda.
   - Trust Score (0-100): Based on source history and tone.

4. **Extract Entities**:
   - Primary Noun: The main subject (Person, Country, or Org).
   - Secondary Noun: The context or second party.

--- OUTPUT FORMAT ---
Respond ONLY in valid JSON. Do not add markdown blocks.

{
  "summary": "Direct, factual news brief.",
  "category": "CategoryString",
  "politicalLean": "Center",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "clusterTopic": "Main Event Name",
  "country": "Global",
  "primaryNoun": "Subject",
  "secondaryNoun": "Context",
  "biasScore": 10, 
  "biasLabel": "Minimal Bias",
  "biasComponents": {
    "linguistic": {"sentimentPolarity": 0, "emotionalLanguage": 0, "loadedTerms": 0, "complexityBias": 0},
    "sourceSelection": {"sourceDiversity": 0, "expertBalance": 0, "attributionTransparency": 0},
    "demographic": {"genderBalance": 0, "racialBalance": 0, "ageRepresentation": 0},
    "framing": {"headlineFraming": 0, "storySelection": 0, "omissionBias": 0}
  },
  "credibilityScore": 90, "credibilityGrade": "A",
  "credibilityComponents": {"sourceCredibility": 0, "factVerification": 0, "professionalism": 0, "evidenceQuality": 0, "transparency": 0, "audienceTrust": 0},
  "reliabilityScore": 90, "reliabilityGrade": "A",
  "reliabilityComponents": {"consistency": 0, "temporalStability": 0, "qualityControl": 0, "publicationStandards": 0, "correctionsPolicy": 0, "updateMaintenance": 0},
  "trustLevel": "High",
  "keyFindings": ["Finding 1", "Finding 2"],
  "recommendations": []
}`;

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
        
        // Use the optimized summary created in aiService
        // Removed .replace(/\n/g, " ") to allow Gemini 2.5 to see paragraph structure
        const articleContent = article.summary || article.content || "";
        
        const data = {
            headline: article.title || "No Title",
            description: article.description || "No Description",
            content: articleContent, // Preserving newlines for better context
            date: new Date().toISOString().split('T')[0]
        };

        return this.interpolate(template, data);
    }
}

export default new PromptManager();
