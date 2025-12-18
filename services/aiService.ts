// services/aiService.ts
import { z } from 'zod';
import promptManager from '../utils/promptManager';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import config from '../utils/config'; 
import { cleanText, extractJSON } from '../utils/helpers'; // FIX: Imported extractor
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
    // FIX: Register keys from central config instead of reading env directly
    if (config.keys.gemini) {
        KeyManager.registerProviderKeys('GEMINI', [config.keys.gemini]);
    } else {
        logger.warn("⚠️ No Gemini API Key found in config");
    }
    
    logger.info(`🤖 AI Service Initialized (Model: ${PRO_MODEL})`);
  }

  async analyzeArticle(article: any, targetModel: string = PRO_MODEL, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    let apiKey = '';
    
    try {
      apiKey = await KeyManager.getKey('GEMINI');
      
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
      }, {
          timeout: 60000 
      });

      KeyManager.reportSuccess(apiKey);
      return this.parseGeminiResponse(response.data, mode);

    } catch (error: any) {
      if (error.response?.status === 429 || error.response?.status >= 500 || error.code === 'ECONNABORTED') {
          if (apiKey) await KeyManager.reportFailure(apiKey, true);
          logger.warn(`⚠️ AI Service Busy/Timeout/Down (Status ${error.response?.status || error.code}). Job will retry.`);
          throw error; 
      }

      if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
          logger.warn(`⚡ AI Service Paused: ${error.message}`);
          throw error; 
      }

      logger.error(`❌ AI Critical Failure (Non-Retriable): ${error.message}`);
      return this.getFallbackAnalysis(article);
    }
  }

  // --- NEW: Batch Embedding for High Efficiency ---
  async createBatchEmbeddings(texts: string[]): Promise<number[][] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI');
        
        // Prepare batch request (Gemini Limit: 100 per call, but we should safeguard)
        const safeBatch = texts.slice(0, 100); 

        const requests = safeBatch.map(text => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: cleanText(text).substring(0, 2000) }] }
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
        
        const response = await apiClient.post(url, { requests }, {
            timeout: 20000 
        });

        KeyManager.reportSuccess(apiKey);

        if (response.data.embeddings) {
            return response.data.embeddings.map((e: any) => e.values);
        }
        return null;

    } catch (error: any) {
        logger.error(`Batch Embedding Error: ${error.message}`);
        return null;
    }
  }

  async createEmbedding(text: string): Promise<number[] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI'); 
        
        const clean = cleanText(text).substring(0, 2000);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
        
        const response = await apiClient.post(url, {
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: clean }] }
        }, {
            timeout: 10000 
        });

        KeyManager.reportSuccess(apiKey);
        return response.data.embedding.values;

    } catch (error: any) {
        logger.error(`Embedding Error: ${error.message}`);
        return null; 
    }
  }

  private parseGeminiResponse(data: any, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates returned from AI');
        
        const rawText = data.candidates[0].content.parts[0].text;
        if (!rawText) throw new Error('Empty response from AI');

        // FIX: Use robust extractor instead of direct JSON.parse
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

        parsed.analysisType = 'Full';
        parsed.trustScore = 0;
        
        const credibility = Number(parsed.credibilityScore) || 0;
        const reliability = Number(parsed.reliabilityScore) || 0;
        
        if (credibility > 0) {
            parsed.trustScore = Math.round(Math.sqrt(credibility * reliability));
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
