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
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        // Updated: await getKey
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
        return this.parseResponse(response.data);

      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        
        if (status === 429) {
             await KeyManager.reportFailure(apiKey, true);
             await sleep(500); 
        } else if (status >= 500) {
            console.warn(`⏳ AI Service (${targetModel}) 5xx Retry ${attempt}/${maxRetries}...`);
            await KeyManager.reportFailure(apiKey, false);
            await sleep(2000 * attempt); 
        } else {
            await KeyManager.reportFailure(apiKey, false); 
            break; 
        }
      }
    }
    throw lastError || new Error(`AI Analysis failed after ${maxRetries} attempts.`);
  }

  async createEmbedding(text: string): Promise<number[] | null> {
      if (!text) return null;
      let apiKey = '';
      try {
          // Updated: await getKey
          apiKey = await KeyManager.getKey('GEMINI');
          
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
          const safeText = text.substring(0, 8000); 

          const response = await axios.post(url, {
              content: { parts: [{ text: safeText }] },
              taskType: "CLUSTERING"
          });

          if (response.data?.embedding?.values) {
              KeyManager.reportSuccess(apiKey);
              return response.data.embedding.values;
          }
          return null;
      } catch (error: any) {
          const status = error.response?.status;
          if (status === 429) {
              await KeyManager.reportFailure(apiKey, true);
          } else {
              await KeyManager.reportFailure(apiKey, false);
          }
          console.error(`❌ Embedding Failed: ${error.message}`);
          throw new Error("Embedding service failure."); 
      }
  }

  private parseResponse(data: any): Partial<IArticle> {
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
        throw new Error(`Failed to parse AI JSON: ${error.message}`);
    }
  }
}

export = new AIService();
