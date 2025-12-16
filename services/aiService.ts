// services/aiService.ts
import { z } from 'zod';
import promptManager from '../utils/promptManager';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import { cleanText } from '../utils/helpers';
import { IArticle } from '../types';

// Use Environment variables for models
const EMBEDDING_MODEL = process.env.AI_MODEL_EMBEDDING || "text-embedding-004";
const PRO_MODEL = process.env.AI_MODEL_PRO || "gemini-2.5-pro";     

// --- GEMINI JSON SCHEMAS ---

const BASIC_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    category: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["Positive", "Negative", "Neutral"] }
  },
  required: ["summary", "category", "sentiment"]
};

const FULL_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    category: { type: "STRING" },
    politicalLean: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["Positive", "Negative", "Neutral"] },
    
    // Scores must be numbers
    biasScore: { type: "NUMBER" },
    credibilityScore: { type: "NUMBER" },
    reliabilityScore: { type: "NUMBER" },
    
    clusterTopic: { type: "STRING" },
    primaryNoun: { type: "STRING" },
    secondaryNoun: { type: "STRING" },
    
    keyFindings: { type: "ARRAY", items: { type: "STRING" } },
    recommendations: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: [
    "summary", "category", "politicalLean", "sentiment", 
    "biasScore", "credibilityScore", "reliabilityScore", 
    "clusterTopic", "keyFindings", "recommendations"
  ]
};

// --- ZOD VALIDATION ---
const ArticleAnalysisSchema = z.object({
    summary: z.string().default("Summary unavailable"),
    category: z.string().default("General"),
    politicalLean: z.string().default("Not Applicable"),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).default('Neutral'),
    
    biasScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    credibilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    reliabilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    
    clusterTopic: z.string().optional(),
    primaryNoun: z.string().optional(),
    secondaryNoun: z.string().optional(),
    
    keyFindings: z.array(z.string()).optional().default([]),
    recommendations: z.array(z.string()).optional().default([])
});

class AIService {
  constructor() {
    KeyManager.loadKeys('GEMINI', 'GEMINI');
    logger.info(`🤖 AI Service Initialized`);
  }

  async analyzeArticle(article: any, targetModel: string = PRO_MODEL, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    let apiKey = '';
    
    // REMOVED: Internal retry loop. 
    // We now let BullMQ handle retries with exponential backoff to save API quota.
    
    try {
      apiKey = await KeyManager.getKey('GEMINI');
      
      // 1. Prepare Prompt & Schema
      const prompt = await promptManager.getAnalysisPrompt(article, mode);
      const schema = mode === 'Basic' ? BASIC_SCHEMA : FULL_SCHEMA;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

      // 2. Call API
      const response = await apiClient.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema, 
          temperature: 0.2,       
          maxOutputTokens: 8192 
        }
      });

      KeyManager.reportSuccess(apiKey);
      return this.parseGeminiResponse(response.data, mode);

    } catch (error: any) {
      // HANDLE SPECIFIC ERRORS
      
      // A. Rate Limits or Server Errors -> Throw so BullMQ Retries later
      if (error.response?.status === 429 || error.response?.status >= 500) {
          if (apiKey) await KeyManager.reportFailure(apiKey, true);
          logger.warn(`⚠️ AI Service Temporarily Unavailable (Status ${error.response.status}). Job will retry.`);
          throw error; // Triggers BullMQ retry
      }

      // B. "Circuit Breaker" / No Keys -> Fail gracefully or Retry later
      if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
          logger.warn(`⚡ AI Service Paused: ${error.message}`);
          throw error; // Triggers BullMQ retry (hoping keys recover)
      }

      // C. Validation/Parsing Errors (Permanent) -> Return Fallback
      logger.error(`❌ AI Critical Failure (Non-Retriable): ${error.message}`);
      return this.getFallbackAnalysis(article);
    }
  }

  // --- EMBEDDING (Vector) ---
  async createEmbedding(text: string): Promise<number[] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI'); 
        
        const clean = cleanText(text).substring(0, 2000);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
        
        const response = await apiClient.post(url, {
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: clean }] }
        });

        KeyManager.reportSuccess(apiKey);
        return response.data.embedding.values;

    } catch (error: any) {
        // Embeddings are optional; we log and return null so pipeline continues
        logger.error(`Embedding Error: ${error.message}`);
        return null; 
    }
  }

  // --- HELPER: Schema Parser ---
  private parseGeminiResponse(data: any, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates returned from AI');
        
        const text = data.candidates[0].content.parts[0].text || "";
        const rawObj = JSON.parse(text);

        // Zod Validation
        const validation = ArticleAnalysisSchema.safeParse(rawObj);

        if (!validation.success) {
            logger.warn(`⚠️ JSON Validation warnings: ${validation.error.message}`);
        }

        const parsed: any = validation.success ? validation.data : rawObj;

        if (mode === 'Basic') {
            return {
                summary: parsed.summary,
                category: parsed.category,
                sentiment: parsed.sentiment,
                politicalLean: 'Not Applicable',
                analysisType: 'SentimentOnly',
                biasScore: 0, credibilityScore: 0, reliabilityScore: 0, trustScore: 0
            };
        }

        parsed.analysisType = 'Full';
        
        // Calculate Trust Score
        parsed.trustScore = 0;
        if (parsed.credibilityScore > 0) {
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }

        return parsed;

    } catch (error: any) {
        throw new Error(`Parsing failed: ${error.message}`);
    }
  }

  private getFallbackAnalysis(article: any): Partial<IArticle> {
      return {
          summary: article.description || "Analysis unavailable (System Error)",
          category: "Uncategorized",
          politicalLean: "Not Applicable",
          biasScore: 0,
          trustScore: 0,
          analysisType: 'SentimentOnly',
          sentiment: 'Neutral'
      };
  }
}

export default new AIService();
