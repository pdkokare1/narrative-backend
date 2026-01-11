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
import { jsonrepair } from 'jsonrepair';

// Centralized Validation
import { BasicAnalysisSchema, FullAnalysisSchema } from '../utils/validationSchemas';

// Centralized Config
const EMBEDDING_MODEL = CONSTANTS.AI_MODELS.EMBEDDING;

// --- SAFETY SETTINGS ---
const NEWS_SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
];

// --- SCHEMAS (Kept same as original) ---
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
    
    biasComponents: {
      type: "OBJECT",
      properties: {
        linguistic: { type: "OBJECT", properties: { sentimentPolarity: { type: "NUMBER" }, emotionalLanguage: { type: "NUMBER" }, loadedTerms: { type: "NUMBER" }, complexityBias: { type: "NUMBER" } }, required: ["sentimentPolarity", "emotionalLanguage", "loadedTerms", "complexityBias"] },
        sourceSelection: { type: "OBJECT", properties: { sourceDiversity: { type: "NUMBER" }, expertBalance: { type: "NUMBER" }, attributionTransparency: { type: "NUMBER" } }, required: ["sourceDiversity", "expertBalance", "attributionTransparency"] },
        demographic: { type: "OBJECT", properties: { genderBalance: { type: "NUMBER" }, racialBalance: { type: "NUMBER" }, ageRepresentation: { type: "NUMBER" } }, required: ["genderBalance", "racialBalance", "ageRepresentation"] },
        framing: { type: "OBJECT", properties: { headlineFraming: { type: "NUMBER" }, storySelection: { type: "NUMBER" }, omissionBias: { type: "NUMBER" } }, required: ["headlineFraming", "storySelection", "omissionBias"] }
      },
      required: ["linguistic", "sourceSelection", "demographic", "framing"]
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
      },
      required: ["sourceCredibility", "factVerification", "professionalism", "evidenceQuality", "transparency", "audienceTrust"]
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
      },
      required: ["consistency", "temporalStability", "qualityControl", "publicationStandards", "correctionsPolicy", "updateMaintenance"]
    }
  },
  required: [
    "summary", "category", "politicalLean", "sentiment", "biasScore", "credibilityScore", 
    "reliabilityScore", "trustLevel", "keyFindings", "biasComponents", "credibilityComponents", "reliabilityComponents"
  ]
};

const NARRATIVE_SCHEMA = {
  type: "OBJECT",
  properties: {
    masterHeadline: { type: "STRING" },
    executiveSummary: { type: "STRING" },
    consensusPoints: { type: "ARRAY", items: { type: "STRING" } },
    divergencePoints: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          point: { type: "STRING" },
          perspectives: {
             type: "ARRAY",
             items: {
                type: "OBJECT",
                properties: { source: { type: "STRING" }, stance: { type: "STRING" } },
                required: ["source", "stance"]
             }
          }
        },
        required: ["point", "perspectives"]
      }
    }
  },
  required: ["masterHeadline", "executiveSummary", "consensusPoints", "divergencePoints"]
};


class AIService {
  constructor() {
    // FIX: Pass the array of keys directly (it is now string[], not string)
    if (config.keys?.gemini && config.keys.gemini.length > 0) {
        KeyManager.registerProviderKeys('GEMINI', config.keys.gemini);
    } else {
        logger.warn("⚠️ No Gemini API Key found in config");
    }
    logger.info(`🤖 AI Service Initialized (Default: ${CONSTANTS.AI_MODELS.FAST})`);
  }

  /**
   * ⚡ Smart Context Optimization
   */
  private optimizeTextForTokenLimits(text: string, isProMode: boolean = false): string {
      let clean = cleanText(text);

      const junkPhrases = [
          "Subscribe to continue reading", "Read more", "Sign up for our newsletter",
          "Follow us on", "© 2023", "© 2024", "© 2025", "All rights reserved",
          "Click here", "Advertisement", "Supported by", "Terms of Service"
      ];
      junkPhrases.forEach(phrase => {
          clean = clean.replace(new RegExp(phrase, 'gi'), '');
      });

      // Gemini 2.5 Context Limits
      // Pro has 2M context, Flash has 1M. We stay safe.
      const SAFE_LIMIT = isProMode ? 1500000 : 800000;

      if (clean.length > SAFE_LIMIT) {
          logger.warn(`⚠️ Article extremely large (${clean.length} chars). Truncating to ${SAFE_LIMIT}.`);
          return clean.substring(0, SAFE_LIMIT) + "\n\n[...Truncated due to extreme length...]";
      }

      return clean;
  }

  /**
   * --- 1. SINGLE ARTICLE ANALYSIS ---
   * OPTIMIZED: Defaults to FAST model (Flash) to save costs.
   */
  async analyzeArticle(article: Partial<IArticle>, targetModel: string = CONSTANTS.AI_MODELS.FAST, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    const isSystemHealthy = await CircuitBreaker.isOpen('GEMINI');
    if (!isSystemHealthy) {
        logger.warn('⚡ Circuit Breaker OPEN for Gemini. Using Fallback.');
        return this.getFallbackAnalysis(article);
    }

    const isPro = targetModel.includes('pro');
    const optimizedArticle = {
        ...article,
        summary: this.optimizeTextForTokenLimits(article.summary || (article as any).content || "", isPro),
        headline: article.headline ? cleanText(article.headline) : ""
    };
    
    if (optimizedArticle.summary.length < CONSTANTS.AI_LIMITS.MIN_CONTENT_CHARS) {
        return this.getFallbackAnalysis(article);
    }

    try {
        const prompt = await promptManager.getAnalysisPrompt(optimizedArticle, mode);
        
        // Execute with Automatic Retry & Key Rotation
        const data = await KeyManager.executeWithRetry<IGeminiResponse>('GEMINI', async (apiKey) => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
            const response = await apiClient.post<IGeminiResponse>(url, {
                contents: [{ parts: [{ text: prompt }] }],
                safetySettings: NEWS_SAFETY_SETTINGS, 
                generationConfig: {
                  responseMimeType: "application/json", 
                  responseSchema: mode === 'Basic' ? BASIC_SCHEMA : FULL_SCHEMA,
                  temperature: 0.1, 
                  maxOutputTokens: 8192 
                }
            }, { timeout: CONSTANTS.TIMEOUTS.EXTERNAL_API });
            return response.data;
        });

        await CircuitBreaker.recordSuccess('GEMINI');
        return this.parseGeminiResponse(data, mode, article);

    } catch (error: any) {
      // If we are here, KeyManager retries have exhausted
      await CircuitBreaker.recordFailure('GEMINI');
      logger.error(`AI Analysis Failed: ${error.message}`);
      return this.getFallbackAnalysis(article);
    }
  }

  /**
   * --- 2. MULTI-DOCUMENT NARRATIVE SYNTHESIS ---
   * QUALITY LOCKED: Always uses PRO model for synthesis.
   */
  async generateNarrative(articles: IArticle[]): Promise<any> {
      if (!articles || articles.length < 2) return null;

      try {
          // FORCE PRO MODEL for complex synthesis
          const targetModel = CONSTANTS.AI_MODELS.QUALITY;

          let docContext = "";
          articles.forEach((art, index) => {
              docContext += `\n--- SOURCE ${index + 1}: ${art.source} ---\n`;
              docContext += `HEADLINE: ${art.headline}\n`;
              docContext += `TEXT: ${cleanText(art.summary)}\n`; 
          });

          const prompt = `
            You are an expert Chief Editor and Narrative Analyst.
            Analyze the following ${articles.length} news reports on the same event.
            
            Your goal is to synthesize a "Master Narrative" that highlights the consensus facts but also clearly explains the divergence in reporting (bias, framing, spin).
            
            OUTPUT REQUIREMENTS:
            1. Master Headline: A neutral, comprehensive headline.
            2. Executive Summary: A 2-paragraph synthesis of what actually happened.
            3. Consensus Points: Facts agreed upon by all sources.
            4. Divergence Points: Specific topics where sources disagree or frame things differently. For each point, list the perspectives.
            
            DOCUMENTS:
            ${docContext}
          `;

          const data = await KeyManager.executeWithRetry<IGeminiResponse>('GEMINI', async (apiKey) => {
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
              const response = await apiClient.post<IGeminiResponse>(url, {
                contents: [{ parts: [{ text: prompt }] }],
                safetySettings: NEWS_SAFETY_SETTINGS,
                generationConfig: {
                  responseMimeType: "application/json",
                  responseSchema: NARRATIVE_SCHEMA,
                  temperature: 0.2, 
                  maxOutputTokens: 8192
                }
              }, { timeout: 120000 }); 
              return response.data;
          });
          
          if (!data.candidates || data.candidates.length === 0) return null;
          return this.parseGeminiResponse(data, 'Narrative', null);

      } catch (error: any) {
          logger.error(`Narrative Generation Failed: ${error.message}`);
          return null;
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
        const BATCH_SIZE = 100;
        // FORCE SEQUENTIAL PROCESSING to avoid rate limits
        // Changed from parallel to single-threaded processing for safety
        const CONCURRENCY_LIMIT = 1; 
        
        const allEmbeddings: number[][] = new Array(texts.length).fill([]);
        const chunks: { text: string; index: number }[][] = [];

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
             const chunk = texts.slice(i, i + BATCH_SIZE).map((text, idx) => ({
                 text: cleanText(text).substring(0, 3000), 
                 index: i + idx
             }));
             chunks.push(chunk);
        }

        // Process chunks sequentially to respect rate limits
        for (const chunk of chunks) {
            const requests = chunk.map(item => ({
                model: `models/${EMBEDDING_MODEL}`,
                content: { parts: [{ text: item.text }] }
            }));

            try {
                // Wrap EACH batch request in retry logic!
                await KeyManager.executeWithRetry('GEMINI', async (apiKey) => {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
                    const response = await apiClient.post<{ embeddings?: { values: number[] }[] }>(url, { requests }, { timeout: 45000 });
                    
                    if (response.data.embeddings) {
                        response.data.embeddings.forEach((emb, localIdx) => {
                            const originalIndex = chunk[localIdx].index;
                            allEmbeddings[originalIndex] = emb.values;
                        });
                    }
                    return response.data;
                });

                // Add delay between batches to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (err: any) {
                logger.warn(`Partial Batch Failure: ${err.message}`);
                // Continue to next chunk even if this one failed
            }
        }

        await CircuitBreaker.recordSuccess('GEMINI');
        return allEmbeddings.filter(e => e.length > 0);

    } catch (error: any) {
        logger.error(`Batch Embedding Error: ${error.message}`);
        return null;
    }
  }

  async createEmbedding(text: string): Promise<number[] | null> {
    try {
        const clean = cleanText(text).substring(0, 3000);
        
        const responseData = await KeyManager.executeWithRetry<{ embedding: { values: number[] } }>('GEMINI', async (apiKey) => {
             const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
             const res = await apiClient.post(url, {
                model: `models/${EMBEDDING_MODEL}`,
                content: { parts: [{ text: clean }] }
             }, { timeout: 10000 });
             return res.data;
        });

        return responseData.embedding.values;

    } catch (error: any) {
        logger.error(`Embedding Error: ${error.message}`);
        return null; 
    }
  }

  // --- Private Helpers ---

  private parseGeminiResponse(data: IGeminiResponse, mode: 'Full' | 'Basic' | 'Narrative', originalArticle: Partial<IArticle> | null): any {
    try {
        if (!data.candidates || data.candidates.length === 0) {
            throw new AppError('AI returned no candidates', 502);
        }
        
        const rawText = data.candidates[0].content.parts[0].text;
        if (!rawText) throw new AppError('AI returned empty content', 502);

        // FIX: Use jsonrepair to handle Markdown blocks or syntax errors from LLM
        const cleanJson = jsonrepair(rawText);
        const parsedRaw = JSON.parse(cleanJson);

        if (mode === 'Narrative') {
            return parsedRaw; 
        }

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
            const trustScore = Math.round(Math.sqrt(validated.credibilityScore * validated.reliabilityScore));
            return { ...validated, analysisType: 'Full', trustScore };
        }

    } catch (error: any) {
        logger.error(`AI Parse/Validation Error: ${error.message}`);
        
        if (mode === 'Full' && originalArticle) {
             logger.warn("Attempting Basic Fallback due to parsing error...");
             return this.getFallbackAnalysis(originalArticle);
        }
        throw new AppError(`Failed to parse AI response: ${error.message}`, 502);
    }
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
