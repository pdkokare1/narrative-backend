// services/aiService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import config from '../utils/config'; 
import AppError from '../utils/AppError';
import { cleanText } from '../utils/helpers';
import { IArticle, IGeminiResponse } from '../types';
import promptManager from '../utils/promptManager';
import CircuitBreaker from '../utils/CircuitBreaker';
import { CONSTANTS } from '../utils/constants';

// Centralized Validation
import { BasicAnalysisSchema, FullAnalysisSchema } from '../utils/validationSchemas';

// Centralized Config
const EMBEDDING_MODEL = CONSTANTS.AI_MODELS.EMBEDDING;
const PRO_MODEL = CONSTANTS.AI_MODELS.QUALITY;

// JSON Schema for Gemini (Strict Mode)
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
   * UPGRADE: Uses Native JSON Mode for 100% reliability.
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
      
      // OPTIMIZATION: Clean text BEFORE prompting to save tokens
      const optimizedArticle = {
          ...article,
          summary: article.summary ? cleanText(article.summary).substring(0, 15000) : "", // Cap input size
          headline: article.headline ? cleanText(article.headline) : ""
      };

      const prompt = await promptManager.getAnalysisPrompt(optimizedArticle, mode);
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

      const response = await apiClient.post<IGeminiResponse>(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json", // STRICT JSON MODE
          responseSchema: mode === 'Basic' ? undefined : GEMINI_JSON_SCHEMA, 
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
   * OPTIMIZED: Uses Parallel Execution (Concurrency) to speed up large batches
   */
  async createBatchEmbeddings(texts: string[]): Promise<number[][] | null> {
    const isSystemHealthy = await CircuitBreaker.isOpen('GEMINI');
    if (!isSystemHealthy) return null;

    if (!texts.length) return [];

    try {
        const apiKey = await KeyManager.getKey('GEMINI');
        const BATCH_SIZE = 100;
        // Load concurrency from Config (Default 5)
        const CONCURRENCY_LIMIT = config.ai.concurrency || 5; 
        
        const allEmbeddings: number[][] = new Array(texts.length).fill([]);
        const chunks: { text: string; index: number }[][] = [];

        // 1. Prepare Chunks with original indices
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
             const chunk = texts.slice(i, i + BATCH_SIZE).map((text, idx) => ({
                 text: cleanText(text).substring(0, 2000), // Enforce clean text limit
                 index: i + idx
             }));
             chunks.push(chunk);
        }

        // 2. Process Chunks in Parallel Batches
        for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
            const parallelBatch = chunks.slice(i, i + CONCURRENCY_LIMIT);
            
            await Promise.all(parallelBatch.map(async (chunk) => {
                const requests = chunk.map(item => ({
                    model: `models/${EMBEDDING_MODEL}`,
                    content: { parts: [{ text: item.text }] }
                }));

                const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
                
                try {
                    const response = await apiClient.post<{ embeddings?: { values: number[] }[] }>(url, { requests }, { timeout: 45000 });
                    
                    if (response.data.embeddings) {
                        response.data.embeddings.forEach((emb, localIdx) => {
                             const originalIndex = chunk[localIdx].index;
                             allEmbeddings[originalIndex] = emb.values;
                        });
                    }
                } catch (err: any) {
                    logger.warn(`Partial Batch Failure: ${err.message}`);
                    // We don't throw here to avoid failing the entire operation, just log missing embeddings
                }
            }));
        }

        KeyManager.reportSuccess(apiKey);
        await CircuitBreaker.recordSuccess('GEMINI');

        // Filter out any empty results from failed chunks
        return allEmbeddings.filter(e => e.length > 0);

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
        
        const response = await apiClient.post<{ embedding: { values: number[] } }>(url, {
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

  private parseGeminiResponse(data: IGeminiResponse, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) {
            throw new AppError('AI returned no candidates', 502);
        }
        
        const rawText = data.candidates[0].content.parts[0].text;
        if (!rawText) throw new AppError('AI returned empty content', 502);

        // NATIVE JSON: We trust the output because of responseMimeType="application/json"
        const parsedRaw = JSON.parse(rawText);

        // Validate & Transform with Centralized Zod Schemas
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
        // Fallback to basic if full fails, rather than crashing
        if (mode === 'Full') {
             logger.warn("Attempting Basic Fallback due to parsing error...");
             return this.getFallbackAnalysis({ ...data, summary: "Analysis partial due to format error." });
        }
        throw new AppError(`Failed to parse AI response: ${error.message}`, 502);
    }
  }

  private async handleAIError(error: any, apiKey: string) {
      const status = error.response?.status || 500;
      const msg = error.message || '';

      // Quota Errors (429) or "Resource Exhausted"
      if (status === 429 || msg.includes('429') || msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED')) {
           logger.warn(`🛑 Gemini Quota Exceeded (Key: ...${apiKey.slice(-4)}). Pausing.`);
           throw new AppError('AI Service Quota Exceeded', 429);
      }
      
      // Retryable errors (Server errors)
      if (status >= 500 || error.code === 'ECONNABORTED') {
          if (apiKey) KeyManager.reportFailure(apiKey, true);
          await CircuitBreaker.recordFailure('GEMINI');
          throw new AppError('AI Service Unavailable', 503); 
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
