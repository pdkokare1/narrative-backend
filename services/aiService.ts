// services/aiService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import config from '../utils/config'; 
import AppError from '../utils/AppError';
import { cleanText, extractJSON } from '../utils/helpers';
import { IArticle } from '../types';

// Centralized Config
const EMBEDDING_MODEL = config.aiModels.embedding;
const PRO_MODEL = config.aiModels.pro;

// --- STRICT GEMINI SCHEMAS ---
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

class AIService {
  constructor() {
    if (config.keys.gemini) {
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
    
    try {
      apiKey = await KeyManager.getKey('GEMINI');
      
      // Use the Prompt Manager to get the prompt string (assuming promptManager exists in utils)
      // Note: We are importing promptManager dynamically or assuming it's available. 
      // For strictness, ensure promptManager is imported at the top if available, 
      // otherwise we construct a basic prompt here.
      const promptManager = require('../utils/promptManager').default; 
      const prompt = await promptManager.getAnalysisPrompt(article, mode);
      
      const schema = mode === 'Basic' ? BASIC_SCHEMA : FULL_SCHEMA;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

      const response = await apiClient.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema, 
          temperature: 0.1, 
          maxOutputTokens: 4096 
        }
      }, { timeout: 60000 });

      KeyManager.reportSuccess(apiKey);
      return this.parseGeminiResponse(response.data, mode);

    } catch (error: any) {
      this.handleAIError(error, apiKey);
      // If we reach here (meaning handleAIError didn't throw), return fallback
      return this.getFallbackAnalysis(article);
    }
  }

  /**
   * BATCH: Generates Embeddings for multiple texts at once
   */
  async createBatchEmbeddings(texts: string[]): Promise<number[][] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI');
        
        // Safeguard: Gemini Batch Limit is usually 100
        const safeBatch = texts.slice(0, 100); 

        const requests = safeBatch.map(text => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: cleanText(text).substring(0, 2000) }] }
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
        
        const response = await apiClient.post(url, { requests }, { timeout: 20000 });

        KeyManager.reportSuccess(apiKey);

        if (response.data.embeddings) {
            return response.data.embeddings.map((e: any) => e.values);
        }
        throw new AppError('Invalid response structure from Batch Embedding API', 502);

    } catch (error: any) {
        logger.error(`Batch Embedding Error: ${error.message}`);
        return null;
    }
  }

  /**
   * SINGLE: Generates Embedding for one text
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

        const jsonString = extractJSON(rawText);
        const parsed = JSON.parse(jsonString);

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

        // Calculate Derived Scores
        parsed.analysisType = 'Full';
        parsed.trustScore = 0;
        
        const credibility = Number(parsed.credibilityScore) || 0;
        const reliability = Number(parsed.reliabilityScore) || 0;
        
        if (credibility > 0) {
            parsed.trustScore = Math.round(Math.sqrt(credibility * reliability));
        }

        return parsed;

    } catch (error: any) {
        logger.error(`AI Parse Error: ${error.message}`);
        throw new AppError(`Failed to parse AI response: ${error.message}`, 502);
    }
  }

  private handleAIError(error: any, apiKey: string) {
      const status = error.response?.status || 500;
      
      // 1. Rate Limits or Server Errors -> Retry
      if (status === 429 || status >= 500 || error.code === 'ECONNABORTED') {
          if (apiKey) KeyManager.reportFailure(apiKey, true);
          logger.warn(`⚠️ AI Service Busy/Timeout (Status ${status}). Job will retry.`);
          throw new AppError('AI Service Unavailable', 503); 
      }

      // 2. Quota Exhausted / Circuit Breaker
      if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
          logger.warn(`⚡ AI Service Paused: ${error.message}`);
          throw new AppError('AI Service Paused (Quota)', 429);
      }

      // 3. Other Errors (Validation, etc) -> Log and allow fallback
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
