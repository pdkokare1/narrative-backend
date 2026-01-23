// narrative-backend/utils/promptManager.ts
import Prompt from '../models/aiPrompts';
import SystemConfig from '../models/systemConfigModel';
import redis from './redisClient';
import logger from './logger';

// Fallback defaults in case DB is empty
const DEFAULT_PERSONALITY = {
    length_instruction: "Minimum 50 words and Maximum 60 words", 
    tone: "Objective, authoritative, and direct (News Wire Style)",
    forbidden_words: "delves, underscores, crucial, tapestry, landscape, moreover, notably, the article, the report, the author, discusses, highlights, according to"
};

const DEFAULT_ANALYSIS_PROMPT = `
Role: You are a Lead Editor for a global news wire.
Task: Analyze the following story and structure the data for our database.

Input Article:
Headline: "{{headline}}"
Description: "{{description}}"
Snippet: "{{content}}"
Date: {{date}}

--- INSTRUCTIONS ---

1. **Summarize (News Wire Style)**:
   - **DIRECT REPORTING:** Act as the primary source. Do NOT say "The article states" or "The report highlights." Just state the facts.
   - **TITLE ACCURACY:** Use the EXACT titles found in the source text.
   - Tone: {{ai_tone}}
   - **Length: {{ai_length}}**
   - Vocabulary: Do NOT use these words: {{ai_forbidden}}

2. **Categorize**:
   - Choose ONE: Politics, Business, Economy, Global Conflict, Tech, Science, Health, Justice, Sports, Entertainment, Lifestyle, Crypto & Finance, Gaming.

3. **CONDITIONAL BIAS & LEAN ANALYSIS (CRITICAL)**:
   - **IF Category is "Politics", "Economy", "Global Conflict", "Justice", "Policy", or "Social Issues":**
     - Political Lean: Left, Left-Leaning, Center, Right-Leaning, Right.
     - Bias Score (0-100): 0 = Neutral, 100 = Propaganda.
   - **IF Category is "Sports", "Entertainment", "Tech", "Science", "Lifestyle", "Gaming", or "Health":**
     - Political Lean: "Not Applicable".
     - Bias Score: 0.
     - Sentiment: "Neutral" (Unless it is clearly an opinion/review).

4. **Trust Score (0-100)**:
   - Based on source credibility and tone (applies to ALL categories).

5. **Smart Briefing**:
   - **Key Findings**: Extract exactly 5 distinct, bullet-point facts.
   - **Recommendations**: Provide 3 actionable tips (e.g., "Watch the match highlights", "Read the bill text").

6. **Extract Entities**:
   - Primary Noun: The main subject.
   - Secondary Noun: The context.

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
  "keyFindings": ["Fact 1", "Fact 2", "Fact 3", "Fact 4", "Fact 5"],
  "recommendations": ["Tip 1", "Tip 2", "Tip 3"]
}`;

const SUMMARY_ONLY_PROMPT = `
Role: You are a News Curator.
Task: Summarize this story concisely.

Input Article:
Headline: "{{headline}}"
Description: "{{description}}"
Snippet: "{{content}}"

--- INSTRUCTIONS ---
1. Summarize: Provide a factual summary with **{{ai_length}}**.
2. Categorize: Choose the most relevant category.
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
    
    // --- 1. Get Personality Config (Cached) ---
    private async getPersonalityConfig() {
        try {
            // Check Cache
            const cached = await redis.get('CONFIG_AI_PERSONALITY');
            if (cached) return JSON.parse(cached);

            // Check DB
            const config = await SystemConfig.findOne({ key: 'ai_personality' });
            if (config && config.value) {
                await redis.set('CONFIG_AI_PERSONALITY', JSON.stringify(config.value), 300); // Cache 5 mins
                return config.value;
            }
        } catch (e) { /* Ignore */ }
        
        return DEFAULT_PERSONALITY;
    }

    // --- 2. Get Template (Cached) ---
    async getTemplate(type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION' | 'SUMMARY_ONLY' = 'ANALYSIS'): Promise<string> {
        const CACHE_KEY = `PROMPT_${type}`;

        try {
            const cached = await redis.get(CACHE_KEY);
            if (cached) return cached;
        } catch (e) { /* Ignore Redis error */ }

        if (type === 'SUMMARY_ONLY') return SUMMARY_ONLY_PROMPT;

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

    public async getAnalysisPrompt(article: any, mode: 'Full' | 'Basic' = 'Full'): Promise<string> {
        const templateType = mode === 'Basic' ? 'SUMMARY_ONLY' : 'ANALYSIS';
        
        // Parallel Fetch: Template + Personality Config
        const [template, personality] = await Promise.all([
            this.getTemplate(templateType),
            this.getPersonalityConfig()
        ]);
        
        const articleContent = article.summary || article.content || "";
        
        const data = {
            headline: article.title || "No Title",
            description: article.description || "No Description",
            content: articleContent, 
            date: new Date().toISOString().split('T')[0],
            
            // Dynamic Injections from Config
            ai_length: personality.length_instruction,
            ai_tone: personality.tone,
            ai_forbidden: personality.forbidden_words
        };

        return this.interpolate(template, data);
    }
}

export default new PromptManager();
