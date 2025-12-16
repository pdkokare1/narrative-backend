// services/aiService.ts
import axios from 'axios';
import { jsonrepair } from 'json-repair';
import { z } from 'zod';
import promptManager from '../utils/promptManager';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import { IArticle } from '../types';

const EMBEDDING_MODEL = "text-embedding-004";
const PRO_MODEL = "gemini-2.5-pro";     

// --- ZOD SCHEMAS (The "Bodyguards") ---
// This defines exactly what we expect from the AI.
const ArticleAnalysisSchema = z.object({
    summary: z.string().default("Summary unavailable"),
    category: z.string().default("General"),
    politicalLean: z.string().default("Not Applicable"),
    sentiment: z.enum(['Positive', 'Negative', 'Neutral']).default('Neutral'),
    
    // Auto-convert strings to numbers if the AI messes up
    biasScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    credibilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    reliabilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
    
    clusterTopic: z.string().optional(),
    primaryNoun: z.string().optional(),
    secondaryNoun: z.string().optional(),
    
    keyFindings: z.array(z.string()).optional().default([]),
    recommendations: z.array(z.string()).optional().default([])
});

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AIService {
  constructor() {
    KeyManager.loadKeys('GEMINI', 'GEMINI');
    logger.info(`🤖 AI Service Initialized (Hardened)`);
  }

  async analyzeArticle(article: any, targetModel: string = PRO_MODEL, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        apiKey = await KeyManager.getKey('GEMINI');
        
        const prompt = await promptManager.getAnalysisPrompt(article, mode);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: mode === 'Basic' ? 0.2 : 0.3,
            maxOutputTokens: 8192 
          }
        }, { timeout: 60000 });

        KeyManager.reportSuccess(apiKey);
        return this.parseGeminiResponse(response.data, mode);

      } catch (error: any) {
        if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
            logger.warn(`⚡ AI Skipped: ${error.message}`);
            return this.getFallbackAnalysis(article);
        }

        const isRateLimit = error.response?.status === 429;
        if (apiKey) await KeyManager.reportFailure(apiKey, isRateLimit);
        
        logger.warn(`⚠️ AI Attempt ${attempt} failed: ${error.message}`);
        
        if (attempt === maxRetries) throw error;
        await sleep(2000 * attempt);
      }
    }
    throw new Error("AI Analysis Failed after retries");
  }

  // --- EMBEDDING (Vector) ---
  async createEmbedding(text: string): Promise<number[] | null> {
    try {
        const apiKey = await KeyManager.getKey('GEMINI'); 
        const cleanText = text.replace(/\n/g, " ").substring(0, 2000);
        
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
        const response = await axios.post(url, {
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: cleanText }] }
        });

        KeyManager.reportSuccess(apiKey);
        return response.data.embedding.values;

    } catch (error: any) {
        logger.error(`Embedding Error: ${error.message}`);
        return null; 
    }
  }

  // --- HELPER: Robust Parser ---
  private parseGeminiResponse(data: any, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates');
        
        let text = data.candidates[0].content.parts[0].text || "";
        
        // 1. Repair Broken JSON (The Magic Fix)
        const repairedJson = jsonrepair(text);
        
        // 2. Parse
        const rawObj = JSON.parse(repairedJson);

        // 3. Validate & Sanitize with Zod
        // "safeParse" tries to validate. If it fails, it tells us why instead of crashing.
        const validation = ArticleAnalysisSchema.safeParse(rawObj);

        if (!validation.success) {
            logger.warn(`⚠️ JSON Validation issues: ${validation.error.message}`);
            // We can still try to use the raw object if it has some data, 
            // but for safety, let's assume we need to fallback or use partial data.
            // For now, let's trust the 'transform' in Zod to have fixed mostly everything.
        }

        // If validation completely failed (rare with .safeParse), fallback to rawObj
        const parsed: any = validation.success ? validation.data : rawObj;

        // If Basic mode, we are done
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

        // Full Mode Logic
        parsed.analysisType = 'Full';
        
        // Calculate Trust Score (Standardized logic)
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
          summary: article.description || "Analysis unavailable (System Busy)",
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
