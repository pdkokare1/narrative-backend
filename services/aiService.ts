// services/aiService.ts
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

  async analyzeArticle(article: any, targetModel: string = PRO_MODEL): Promise<Partial<IArticle>> {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        apiKey = await KeyManager.getKey('GEMINI');
        
        const prompt = await promptManager.getAnalysisPrompt(article);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
            maxOutputTokens: 8192 
          }
        }, { timeout: 60000 });

        KeyManager.reportSuccess(apiKey);
        return this.parseGeminiResponse(response.data);

      } catch (error: any) {
        // --- NEW: Circuit Breaker Handling ---
        if (error.message.includes('CIRCUIT_BREAKER') || error.message.includes('NO_KEYS')) {
            console.warn(`⚡ AI Skipped: ${error.message}`);
            // Fallback to basic object to allow saving article without AI
            return {
                summary: article.description || "Analysis unavailable (System Busy)",
                category: "Uncategorized",
                politicalLean: "Not Applicable",
                biasScore: 0,
                trustScore: 0,
                analysisType: 'SentimentOnly', // Mark as basic
                sentiment: 'Neutral'
            };
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
        const apiKey = await KeyManager.getKey('GEMINI'); // Uses same pool
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
        return null; // Fail silently for embeddings, not critical
    }
  }

  // --- HELPER: Parser ---
  private parseGeminiResponse(data: any): Partial<IArticle> {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates');
        
        let text = data.candidates[0].content.parts[0].text;
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            text = text.substring(jsonStart, jsonEnd + 1);
        }

        let parsed = JSON.parse(text);

        // Sanitize & Default
        parsed.summary = parsed.summary || 'Summary unavailable';
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        parsed.sentiment = parsed.sentiment || 'Neutral';
        parsed.politicalLean = parsed.politicalLean || 'Not Applicable';
        
        const toNum = (v: any) => Math.round(Number(v) || 0);
        parsed.biasScore = toNum(parsed.biasScore);
        parsed.credibilityScore = toNum(parsed.credibilityScore);
        parsed.reliabilityScore = toNum(parsed.reliabilityScore);
        
        parsed.trustScore = 0;
        if (parsed.analysisType === 'Full' && parsed.credibilityScore > 0) {
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }

        return parsed;

    } catch (error: any) {
        throw new Error(`Parsing failed: ${error.message}`);
    }
  }
}

export default new AIService();
