// services/aiService.js
const axios = require('axios');
const { getAnalysisPrompt } = require('../utils/prompts');

// --- CONSTANTS ---
const EMBEDDING_MODEL = "text-embedding-004";
const FLASH_MODEL = "gemini-2.5-flash"; 
const PRO_MODEL = "gemini-2.5-pro";     

// Key Statuses
const KEY_STATUS = {
    ACTIVE: 'active',
    COOLDOWN: 'cooldown',
    FAILED: 'failed'
};
const COOLDOWN_MINUTES = 10;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AIService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyStatus = new Map(); // Maps key to {status, lastFailed}
    
    this.apiKeys.forEach(key => {
      this.keyStatus.set(key, { status: KEY_STATUS.ACTIVE, lastFailed: 0 });
    });
    console.log(`🤖 AI Service Initialized: ${this.apiKeys.length} keys loaded.`);
  }

  loadApiKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
      if (key) keys.push(key);
    }
    const defaultKey = process.env.GEMINI_API_KEY?.trim();
    if (keys.length === 0 && defaultKey) keys.push(defaultKey);
    
    if (keys.length === 0) console.warn("⚠️ No Gemini API keys found.");
    return keys;
  }

  getValidApiKey() {
    if (this.apiKeys.length === 0) throw new Error("No Gemini Keys available");
    
    for (let i = 0; i < this.apiKeys.length; i++) {
        const key = this.apiKeys[this.currentKeyIndex];
        const statusObj = this.keyStatus.get(key);

        // Check if cooldown period is over
        if (statusObj.status === KEY_STATUS.COOLDOWN) {
            const cooldownEnd = statusObj.lastFailed + COOLDOWN_MINUTES * 60 * 1000;
            if (Date.now() > cooldownEnd) {
                this.keyStatus.set(key, { status: KEY_STATUS.ACTIVE, lastFailed: 0 });
                console.log(`✅ Key ...${key.slice(-4)} cooldown ended. Back online.`);
                return key;
            }
        }
        
        // Return active key
        if (statusObj.status === KEY_STATUS.ACTIVE) {
            this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
            return key;
        }

        // Move to next key if current one is on cooldown or failed
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    }

    throw new Error("All Gemini API keys are currently exhausted or on cooldown.");
  }

  recordFailure(apiKey, isRateLimit = false) {
    if (apiKey) {
        if (isRateLimit) {
            this.keyStatus.set(apiKey, { status: KEY_STATUS.COOLDOWN, lastFailed: Date.now() });
            console.warn(`❌ Rate Limit Hit on key ...${apiKey.slice(-4)}. Starting ${COOLDOWN_MINUTES}m cooldown.`);
        } else {
            // For general 400/500 errors, just mark it as failed (maybe permanently if it happens too much, but we keep it simple for now)
            console.error(`⚠️ Permanent Error on key ...${apiKey.slice(-4)}. Skipping.`);
            this.keyStatus.set(apiKey, { status: KEY_STATUS.FAILED, lastFailed: Date.now() });
        }
    }
  }

  // --- Main Analysis Function ---
  async analyzeArticle(article, targetModel = PRO_MODEL) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        apiKey = this.getValidApiKey();
        
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

        // On success, reset the key status if it was temporarily failed/cooldown
        const statusObj = this.keyStatus.get(apiKey);
        if (statusObj && statusObj.status !== KEY_STATUS.ACTIVE) {
             this.keyStatus.set(apiKey, { status: KEY_STATUS.ACTIVE, lastFailed: 0 });
        }
        
        return this.parseResponse(response.data);

      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        
        if (status === 429) {
             this.recordFailure(apiKey, true); // Rate Limit Hit -> Cooldown
             await sleep(500); // Small pause before retrying with a new key
        } else if (status >= 500) {
            console.warn(`⏳ AI Service (${targetModel}) 5xx Retry ${attempt}/${maxRetries}...`);
            await sleep(2000 * attempt); 
        } else {
            this.recordFailure(apiKey, false); // General failure -> Mark as failed
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
          apiKey = this.getValidApiKey(); // Use the same rotation logic
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
          const safeText = text.substring(0, 8000); 

          const response = await axios.post(url, {
              content: { parts: [{ text: safeText }] },
              taskType: "CLUSTERING"
          });

          if (response.data?.embedding?.values) {
              const statusObj = this.keyStatus.get(apiKey);
              if (statusObj && statusObj.status !== KEY_STATUS.ACTIVE) {
                   this.keyStatus.set(apiKey, { status: KEY_STATUS.ACTIVE, lastFailed: 0 });
              }
              return response.data.embedding.values;
          }
          return null;
      } catch (error) {
          const status = error.response?.status;
          if (status === 429) {
              this.recordFailure(apiKey, true); // Rate Limit Hit -> Cooldown
          } else {
              this.recordFailure(apiKey, false); // General failure
          }
          console.error(`❌ Embedding Failed: ${error.message}`);
          throw new Error("Embedding service failure."); // Throw to stop the migration loop
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
