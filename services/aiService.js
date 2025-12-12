// services/aiService.js
const axios = require('axios');
const { getAnalysisPrompt } = require('../utils/prompts');
const KeyManager = require('../utils/KeyManager'); // <--- NEW: Central Manager

// --- CONSTANTS ---
const EMBEDDING_MODEL = "text-embedding-004";
const FLASH_MODEL = "gemini-2.5-flash"; 
const PRO_MODEL = "gemini-2.5-pro";     

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AIService {
  constructor() {
    // 1. Initialize Keys via Manager
    KeyManager.loadKeys('GEMINI', 'GEMINI');
    console.log(`🤖 AI Service Initialized`);
  }

  // --- Main Analysis Function ---
  async analyzeArticle(article, targetModel = PRO_MODEL) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        // 2. Get Valid Key from Manager
        apiKey = KeyManager.getKey('GEMINI');
        
        const prompt = getAnalysisPrompt(article);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3,
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 8192 
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        }, { timeout: 60000 });

        // 3. Report Success (Resets error counters)
        KeyManager.reportSuccess(apiKey);
        
        return this.parseResponse(response.data);

      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        
        if (status === 429) {
             // 4. Report Rate Limit (Triggers Cooldown)
             KeyManager.reportFailure(apiKey, true);
             await sleep(500); 
        } else if (status >= 500) {
            console.warn(`⏳ AI Service (${targetModel}) 5xx Retry ${attempt}/${maxRetries}...`);
            KeyManager.reportFailure(apiKey, false);
            await sleep(2000 * attempt); 
        } else {
            // General failure (e.g. 400 Bad Request)
            KeyManager.reportFailure(apiKey, false); 
            break; 
        }
      }
    }
    throw lastError || new Error(`AI Analysis failed after ${maxRetries} attempts.`);
  }

  // --- Vector Embedding Function ---
  async createEmbedding(text) {
      if (!text) return null;
      let apiKey = '';
      try {
          apiKey = KeyManager.getKey('GEMINI');
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
      } catch (error) {
          const status = error.response?.status;
          if (status === 429) {
              KeyManager.reportFailure(apiKey, true);
          } else {
              KeyManager.reportFailure(apiKey, false);
          }
          console.error(`❌ Embedding Failed: ${error.message}`);
          throw new Error("Embedding service failure."); 
      }
  }

  // --- Response Parser (Unchanged) ---
  parseResponse(data) {
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
        
        const toNum = (v) => Math.round(Number(v) || 0);
        parsed.biasScore = toNum(parsed.biasScore);
        parsed.credibilityScore = toNum(parsed.credibilityScore);
        parsed.reliabilityScore = toNum(parsed.reliabilityScore);
        
        parsed.trustScore = 0;
        if (parsed.analysisType === 'Full' && parsed.credibilityScore > 0) {
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }

        return parsed;

    } catch (error) {
        throw new Error(`Failed to parse AI JSON: ${error.message}`);
    }
  }
}

module.exports = new AIService();
