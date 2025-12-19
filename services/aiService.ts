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

// --- STRICT JSON SCHEMAS ---
// These define exactly what Gemini MUST return. 
// This replaces the old method of "hoping" it returns valid JSON.

const BASIC_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    category: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["Positive", "Negative", "Neutral"] }
  },
  required: ["summary", "category", "sentiment"]
};

// Updated: Expanded Schema to match Gemini 2.5 Pro's capabilities and your Prompt structure
const FULL_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    category: { type: "STRING" },
    politicalLean: { type: "STRING" },
    sentiment: { type: "STRING", enum: ["Positive", "Negative", "Neutral"] },
    biasScore: { type: "NUMBER" },
    biasLabel: { type: "STRING" },
    credibilityScore: { type: "NUMBER" },
    credibilityGrade: { type: "STRING" },
    reliabilityScore: { type: "NUMBER" },
    reliabilityGrade: { type: "STRING" },
    trustLevel: { type: "STRING" },
    clusterTopic: { type: "STRING" },
    country: { type: "STRING" },
    primaryNoun: { type: "STRING" },
    secondaryNoun: { type: "STRING" },
    keyFindings: { type: "ARRAY", items: { type: "STRING" } },
    recommendations: { type: "ARRAY", items: { type: "STRING" } },
    
    // Complex Analysis Objects
    biasComponents: {
      type: "OBJECT",
      properties: {
        linguistic: { type: "OBJECT", properties: { sentimentPolarity: { type: "NUMBER" }, emotionalLanguage: { type: "NUMBER" }, loadedTerms: { type: "NUMBER" }, complexityBias: { type: "NUMBER" } } },
        sourceSelection: { type: "OBJECT", properties: { sourceDiversity: { type: "NUMBER" }, expertBalance: { type: "NUMBER" }, attributionTransparency: { type: "NUMBER" } } },
        demographic: { type: "OBJECT", properties: { genderBalance: { type: "NUMBER" }, racialBalance: { type: "NUMBER" }, ageRepresentation: { type: "NUMBER" } } },
        framing: { type: "OBJECT", properties: { headlineFraming: { type: "NUMBER" }, storySelection: { type: "NUMBER" }, omissionBias: { type: "NUMBER" } } }
      }
    },
    credibilityComponents: {
      type: "OBJECT",
      properties: {
        sourceCredibility: { type: "NUMBER" },
        factVerification: { type: "NUMBER" },
        professionalism: { type: "NUMBER" },
        evidenceQuality: { type: "NUMBER" },
        transparency: { type: "NUMBER" },
        audienceTrust: { type: "NUMBER" }
      }
    },
    reliabilityComponents: {
      type: "OBJECT",
      properties: {
        consistency: { type: "NUMBER" },
        temporalStability: { type: "NUMBER" },
        qualityControl: { type: "NUMBER" },
        publicationStandards: { type: "NUMBER" },
        correctionsPolicy: { type: "NUMBER" },
        updateMaintenance: { type: "NUMBER" }
      }
    }
  },
  required: [
    "summary", "category", "politicalLean", "sentiment", "biasScore", "credibilityScore", 
    "reliabilityScore", "trustLevel", "keyFindings"
  ]
};

class AIService {
  constructor() {
    if (config.keys?.gemini) {
        KeyManager.registerProviderKeys('GEMINI', [config.keys.gemini]);
    } else {
        logger.warn("⚠️ No Gemini API Key found in config");
    }
    logger.info(`🤖 AI Service Initialized (Quality: ${CONSTANTS.AI_MODELS.QUALITY})`);
  }

  /**
   * ⚡ Smart Context Optimization (Token Saver)
   * Instead of blindly cutting the middle, this preserves the structure:
   * 1. Intro (First 25%): Essential for context/who/what.
   * 2. Middle (Sampled): Takes a slice from the exact middle to catch developments.
   * 3. Outro (Last 20%): Essential for conclusion/impact.
   */
  private optimizeTextForTokenLimits(text: string): string {
      let clean = cleanText(text);

      // 1. Remove standard boilerplate (Marketing/Legal)
      const junkPhrases = [
          "Subscribe to continue reading", "Read more", "Sign up for our newsletter",
          "Follow us on", "© 2023", "© 2024", "© 2025", "All rights reserved",
          "Click here", "Advertisement", "Supported by", "Terms of Service"
      ];
      junkPhrases.forEach(phrase => {
          clean = clean.replace(new RegExp(phrase, 'gi'), '');
      });

      // Updated for Gemini 2.5: Increased fallback limit to 300k chars
      const MAX_CHARS = CONSTANTS.AI_LIMITS.MAX_INPUT_CHARS || 300000;
      
      if (clean.length > MAX_CHARS) {
          const keepIntro = Math.floor(MAX_CHARS * 0.25);
          const keepOutro = Math.floor(MAX_CHARS * 0.20);
          const keepMiddle = Math.floor(MAX_CHARS * 0.15); // Sample a core section
          
          const partA = clean.substring(0, keepIntro);
          
          // Smart Middle Sample: Grab a chunk from the mathematical center of the text
          const midPoint = Math.floor(clean.length / 2);
          const partB = clean.substring(midPoint - (keepMiddle / 2), midPoint + (keepMiddle / 2));
          
          const partC = clean.substring(clean.length - keepOutro);
          
          return `${partA}\n\n[...Timeline Skipped...]\n\n${partB}\n\n[...Details Skipped...]\n\n${partC}`;
      }

      return clean;
  }

  /**
   * Analyzes an article using Generative AI (Strict Mode)
   */
  async analyzeArticle(article: Partial<IArticle>, targetModel: string = CONSTANTS.AI_MODELS.QUALITY, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
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
      // We pass the full summary/content here to be processed by promptManager
      const optimizedArticle = {
          ...article,
          // FIX: Access content securely with fallback
          summary: this.optimizeTextForTokenLimits(article.summary || (article as any).content || ""),
          headline: article.headline ? cleanText(article.headline) : ""
      };
      
      // Cost Control: Skip if content is ghost-thin
      if (optimizedArticle.summary.length < CONSTANTS.AI_LIMITS.MIN_CONTENT_CHARS) {
          logger.warn(`Skipping AI analysis: Content too short (${optimizedArticle.summary.length} chars)`);
          return this.getFallbackAnalysis(article);
      }

      const prompt = await promptManager.getAnalysisPrompt(optimizedArticle, mode);
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

      // 2. Call API with Strict Schema
      const response = await apiClient.post<IGeminiResponse>(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json", 
          responseSchema: mode === 'Basic' ? BASIC_SCHEMA : FULL_SCHEMA,
          temperature: 0.1, // Low temp for factual consistency
          maxOutputTokens: 4096 
        }
      }, { timeout: CONSTANTS.TIMEOUTS.EXTERNAL_API }); // Use centralized timeout

      KeyManager.reportSuccess(apiKey);
      await CircuitBreaker.recordSuccess('GEMINI');

      // Pass the *original* article for safer fallback
      return this.parseGeminiResponse(response.data, mode, article);

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

    if (!texts.length) return [];

    try {
        const apiKey = await KeyManager.getKey('GEMINI');
        const BATCH_SIZE = 100;
        const CONCURRENCY_LIMIT = config.ai.concurrency || 5; 
        
        const allEmbeddings: number[][] = new Array(texts.length).fill([]);
        const chunks: { text: string; index: number }[][] = [];

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
             const chunk = texts.slice(i, i + BATCH_SIZE).map((text, idx) => ({
                 text: cleanText(text).substring(0, 2000), // Enforce strict limit for embeddings
                 index: i + idx
             }));
             chunks.push(chunk);
        }

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
                }
            }));
        }

        KeyManager.reportSuccess(apiKey);
        await CircuitBreaker.recordSuccess('GEMINI');

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

  private parseGeminiResponse(data: IGeminiResponse, mode: 'Full' | 'Basic', originalArticle: Partial<IArticle>): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) {
            throw new AppError('AI returned no candidates', 502);
        }
        
        // Gemini 2.5 + Structured Output returns clean JSON text directly.
        const rawText = data.candidates[0].content.parts[0].text;
        if (!rawText) throw new AppError('AI returned empty content', 502);

        const parsedRaw = JSON.parse(rawText);

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
            
            // Calculate derivative scores
            const trustScore = Math.round(Math.sqrt(validated.credibilityScore * validated.reliabilityScore));
            
            return {
                ...validated,
                analysisType: 'Full',
                trustScore
            };
        }

    } catch (error: any) {
        logger.error(`AI Parse/Validation Error: ${error.message}`);
        if (mode === 'Full') {
             logger.warn("Attempting Basic Fallback due to parsing error...");
             // Updated: Pass original article so we don't lose the summary in the fallback
             return this.getFallbackAnalysis(originalArticle);
        }
        throw new AppError(`Failed to parse AI response: ${error.message}`, 502);
    }
  }

  private async handleAIError(error: any, apiKey: string) {
      const status = error.response?.status || 500;
      const msg = error.message || '';

      if (status === 429 || msg.includes('429') || msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED')) {
           logger.warn(`🛑 Gemini Quota Exceeded (Key: ...${apiKey.slice(-4)}). Pausing.`);
           throw new AppError('AI Service Quota Exceeded', 429);
      }
      
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
