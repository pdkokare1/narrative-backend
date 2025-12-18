// services/aiService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import config from '../utils/config'; 
import AppError from '../utils/AppError';
import { cleanText, extractJSON } from '../utils/helpers';
import { IArticle } from '../types';
import promptManager from '../utils/promptManager';
import CircuitBreaker from '../utils/CircuitBreaker';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

// Centralized Config
const EMBEDDING_MODEL = config.aiModels?.embedding || 'text-embedding-004';
const PRO_MODEL = config.aiModels?.pro || 'gemini-pro';

// --- ZOD SCHEMAS FOR VALIDATION ---
const SentimentSchema = z.enum(["Positive", "Negative", "Neutral"]);

const BasicAnalysisSchema = z.object({
  summary: z.string(),
  category: z.string(),
  sentiment: SentimentSchema.optional().default("Neutral")
});

const FullAnalysisSchema = z.object({
  summary: z.string(),
  category: z.string(),
  politicalLean: z.string().optional().default("Center"),
  sentiment: SentimentSchema.optional().default("Neutral"),
  biasScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  credibilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  reliabilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  clusterTopic: z.string().optional(),
  primaryNoun: z.string().optional(),
  secondaryNoun: z.string().optional(),
  keyFindings: z.array(z.string()).optional().default([]),
  recommendations: z.array(z.string()).optional().default([])
});

// JSON Schema for Gemini (Guidance only)
const GEMINI_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    category: { type: "STRING" },
    politicalLean: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["Positive", "Negative", "Neutral"] },
    biasScore: { type: "NUMBER" },
    credibilityScore: { type: "NUMBER" },
    reliabilityScore: { type: "NUMBER" },
    clusterTopic: { type: "STRING" },
    keyFindings: { type: "ARRAY", items: { type: "STRING" } },
    recommendations: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["summary", "category", "politicalLean", "sentiment"]
};

class AIService {
  constructor() {
    if (config.keys?.gemini) {
        KeyManager.registerProviderKeys('GEMINI', [config.keys.gemini]);
    } else {
        logger.warn("⚠️ No Gemini API Key found in config");
    }
    logger.info(`🤖 AI Service Initialized (Model: ${PRO_MODEL})`);
  }

  /**
   * Analyzes an article using the Generative AI Model
   */
  async analyzeArticle(article: Partial<IArticle>, targetModel: string = PRO_MODEL, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    let apiKey = '';
    
    // 1. Circuit Breaker Check
    const isSystemHealthy = await CircuitBreaker.isOpen('GEMINI');
    if (!isSystemHealthy) {
        logger.warn('⚡ Circuit Breaker OPEN for Gemini. Using Fallback.');
        return this.getFallbackAnalysis(article);
    }

    try {
      apiKey = await KeyManager.getKey('GEMINI');
      
      const prompt = await promptManager.getAnalysisPrompt(article, mode);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

      const response = await apiClient.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: mode === 'Basic' ? undefined : GEMINI_JSON_SCHEMA, // Use Strict Schema only for full
          temperature: 0.1, 
          maxOutputTokens: 4096 
        }
      }, { timeout: 60000 });

      KeyManager.reportSuccess(apiKey);
      await CircuitBreaker.recordSuccess('GEMINI');

      return this.parseGeminiResponse(response.data, mode);

    } catch (error: any) {
      await this.handleAIError(error, apiKey);
      return this.getFallbackAnalysis(article);
    }
  }

  /**
   * BATCH: Generates Embeddings
   */
  async createBatchEmbeddings(texts: string[]): Promise<number[][] | null> {
    const isSystemHealthy = await CircuitBreaker.isOpen('GEMINI');
    if (!isSystemHealthy) return null;

    try {
        const apiKey = await KeyManager.getKey('GEMINI');
        const safeBatch = texts.slice(0, 100); 

        const requests = safeBatch.map(text => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: cleanText(text).substring(0, 2000) }] }
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
        const response = await apiClient.post(url, { requests }, { timeout: 20000 });

        KeyManager.reportSuccess(apiKey);
        await CircuitBreaker.recordSuccess('GEMINI');

        if (response.data.embeddings) {
            return response.data.embeddings.map((e: any) => e.values);
        }
        return null;
    } catch (error: any) {
        logger.error(`Batch Embedding Error: ${error.message}`);
        await CircuitBreaker.recordFailure('GEMINI');
        return null;
    }
  }

  /**
   * SINGLE: Generates Embedding
   */
  async createEmbedding(text: string): Promise<number[] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI'); 
        const clean = cleanText(text).substring(0, 2000);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
        
        const response = await apiClient.post(url, {
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: clean }] }
        }, { timeout: 10000 });

        KeyManager.reportSuccess(apiKey);
        return response.data.embedding.values;

    } catch (error: any) {
        logger.error(`Embedding Error: ${error.message}`);
        return null; 
    }
  }

  // --- Private Helpers ---

  private parseGeminiResponse(data: any, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) {
            throw new AppError('AI returned no candidates', 502);
        }
        
        const rawText = data.candidates[0].content.parts[0].text;
        if (!rawText) throw new AppError('AI returned empty content', 502);

        // 1. Extract JSON-like substring
        const jsonString = extractJSON(rawText);
        
        // 2. Repair JSON (Safe call)
        let repairedJson = jsonString;
        try {
           repairedJson = jsonrepair(jsonString);
        } catch (e) {
           logger.warn("JSON Repair failed, attempting raw parse");
        }
        
        // 3. Parse
        const parsedRaw = JSON.parse(repairedJson);

        // 4. Validate & Transform with Zod
        let validated;
        if (mode === 'Basic') {
            validated = BasicAnalysisSchema.parse(parsedRaw);
            return {
                ...validated,
                politicalLean: 'Not Applicable',
                analysisType: 'SentimentOnly',
                biasScore: 0, credibilityScore: 0, reliabilityScore: 0, trustScore: 0
            };
        } else {
            validated = FullAnalysisSchema.parse(parsedRaw);
            
            // Calculate Trust Score
            const trustScore = Math.round(Math.sqrt(validated.credibilityScore * validated.reliabilityScore));
            
            return {
                ...validated,
                analysisType: 'Full',
                trustScore
            };
        }

    } catch (error: any) {
        logger.error(`AI Parse/Validation Error: ${error.message}`);
        throw new AppError(`Failed to parse AI response: ${error.message}`, 502);
    }
  }

  private async handleAIError(error: any, apiKey: string) {
      const status = error.response?.status || 500;
      
      // Retryable errors
      if (status === 429 || status >= 500 || error.code === 'ECONNABORTED') {
          if (apiKey) KeyManager.reportFailure(apiKey, true);
          await CircuitBreaker.recordFailure('GEMINI');
          throw new AppError('AI Service Unavailable', 503); 
      }

      // Permanent errors
      if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
          throw new AppError('AI Service Paused (Quota)', 429);
      }

      logger.error(`❌ AI Critical Failure: ${error.message}`);
  }

  private getFallbackAnalysis(article: Partial<IArticle>): Partial<IArticle> {
      return {
          summary: article.summary || "Analysis unavailable (System Error)",
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
