// src/services/aiService.ts
import axios from 'axios';
import promptManager from '../utils/promptManager';
import KeyManager from '../utils/KeyManager';
import { IArticle } from '../types';

const EMBEDDING_MODEL = "text-embedding-004";
const PRO_MODEL = "gemini-2.5-pro";     

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AIService {
  constructor() {
    KeyManager.loadKeys('GEMINI', 'GEMINI');
    console.log(`🤖 AI Service Initialized`);
  }

  async analyzeArticle(article: any, targetModel: string = PRO_MODEL, mode: 'Full' | 'Basic' = 'Full'): Promise<Partial<IArticle>> {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        apiKey = await KeyManager.getKey('GEMINI');
        
        // Pass mode to prompt manager - Centralized Logic
        const prompt = await promptManager.getAnalysisPrompt(article, mode);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: mode === 'Basic' ? 0.2 : 0.3, // Lower temp for basic summary
            maxOutputTokens: 8192 
          }
        }, { timeout: 60000 });

        KeyManager.reportSuccess(apiKey);
        return this.parseGeminiResponse(response.data, mode);

      } catch (error: any) {
        if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
            console.warn(`⚡ AI Skipped: ${error.message}`);
            return this.getFallbackAnalysis(article);
        }

        const isRateLimit = error.response?.status === 429;
        if (apiKey) await KeyManager.reportFailure(apiKey, isRateLimit);
        
        console.warn(`⚠️ AI Attempt ${attempt} failed: ${error.message}`);
        
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
        console.error("Embedding Error:", error.message);
        return null; 
    }
  }

  // --- HELPER: Parser ---
  private parseGeminiResponse(data: any, mode: 'Full' | 'Basic'): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates');
        
        let text = data.candidates[0].content.parts[0].text || "";
        
        // 1. Aggressive Clean
        text = text.trim();
        // Remove markdown fencing
        text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
        
        // 2. Locate JSON bounds
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        
        if (jsonStart !== -1 && jsonEnd !== -1) {
            text = text.substring(jsonStart, jsonEnd + 1);
        } else {
            throw new Error("Invalid JSON structure found");
        }

        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            // Last ditch effort: Try to fix trailing commas
            const fixedText = text.replace(/,(\s*[}\]])/g, '$1');
            parsed = JSON.parse(fixedText);
        }

        // If Basic mode, ensure defaults are set for missing expensive fields
        if (mode === 'Basic') {
            return {
                summary: parsed.summary || 'Summary unavailable',
                category: parsed.category || 'General',
                sentiment: parsed.sentiment || 'Neutral',
                politicalLean: 'Not Applicable',
                analysisType: 'SentimentOnly',
                biasScore: 0,
                credibilityScore: 0,
                reliabilityScore: 0,
                trustScore: 0
            };
        }

        // Full Mode Parsing
        parsed.summary = parsed.summary || 'Summary unavailable';
        parsed.analysisType = 'Full';
        parsed.sentiment = parsed.sentiment || 'Neutral';
        parsed.politicalLean = parsed.politicalLean || 'Not Applicable';
        
        const toNum = (v: any) => Math.round(Number(v) || 0);
        parsed.biasScore = toNum(parsed.biasScore);
        parsed.credibilityScore = toNum(parsed.credibilityScore);
        parsed.reliabilityScore = toNum(parsed.reliabilityScore);
        
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
