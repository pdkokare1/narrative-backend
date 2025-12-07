// services/aiService.js
const axios = require('axios');
const { getAnalysisPrompt } = require('../utils/prompts');

// --- CONSTANTS ---
// We use the new 2.5 series models for better performance
const EMBEDDING_MODEL = "text-embedding-004";
const FLASH_MODEL = "gemini-2.5-flash"; // Fast & Cheap (Soft News)
const PRO_MODEL = "gemini-2.5-pro";     // Smart & Nuanced (Hard News)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class AIService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();
    
    // Trackers
    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
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

  getNextApiKey() {
    if (this.apiKeys.length === 0) throw new Error("No Gemini Keys available");
    
    // Simple round-robin rotation
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  recordSuccess(apiKey) {
    if (apiKey) {
        this.keyErrorCount.set(apiKey, 0);
    }
  }

  recordError(apiKey) {
    if (apiKey) {
        const current = this.keyErrorCount.get(apiKey) || 0;
        this.keyErrorCount.set(apiKey, current + 1);
        console.warn(`⚠️ Error on key ...${apiKey.slice(-4)}. Count: ${current + 1}`);
    }
  }

  /**
   * Main Analysis Function
   * @param {Object} article - The article object
   * @param {String} targetModel - 'gemini-2.5-pro' or 'gemini-2.5-flash'
   */
  async analyzeArticle(article, targetModel = PRO_MODEL) {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let apiKey = '';
      try {
        apiKey = this.getNextApiKey();
        
        // 1. Generate Prompt
        const prompt = getAnalysisPrompt(article);
        
        // 2. Build URL based on requested model
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

        // 3. Make Request
        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3, // Lower temp for factual consistency
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
        }, { timeout: 60000 }); // 60s timeout

        this.recordSuccess(apiKey);
        return this.parseResponse(response.data);

      } catch (error) {
        lastError = error;
        this.recordError(apiKey);
        
        const status = error.response?.status;
        if (status === 429 || status >= 500) {
            console.warn(`⏳ AI Service (${targetModel}) Retry ${attempt}/${maxRetries}...`);
            await sleep(2000 * attempt); // Exponential backoff
        } else {
            break; // Don't retry client errors (400)
        }
      }
    }
    throw lastError || new Error(`AI Analysis failed after ${maxRetries} attempts.`);
  }

  /**
   * Vector Embedding Function
   * Used for clustering articles by semantic meaning.
   */
  async createEmbedding(text) {
      if (!text) return null;
      const apiKey = this.getNextApiKey();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

      try {
          // Truncate to avoid token limits (8000 chars is roughly 2000 tokens)
          const safeText = text.substring(0, 8000); 

          const response = await axios.post(url, {
              content: { parts: [{ text: safeText }] },
              taskType: "CLUSTERING"
          });

          if (response.data?.embedding?.values) {
              this.recordSuccess(apiKey);
              return response.data.embedding.values;
          }
          return null;
      } catch (error) {
          console.error(`❌ Embedding Failed: ${error.message}`);
          return null; 
      }
  }

  // --- Response Parser ---
  parseResponse(data) {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates');
        
        let text = data.candidates[0].content.parts[0].text;
        
        // Sanitize Markdown JSON
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        
        // Extract JSON block if needed
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            text = text.substring(jsonStart, jsonEnd + 1);
        }

        let parsed = JSON.parse(text);

        // --- Defaults & Sanitization ---
        parsed.summary = parsed.summary || 'Summary unavailable';
        
        // Ensure critical fields exist
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        parsed.sentiment = parsed.sentiment || 'Neutral';
        parsed.politicalLean = parsed.politicalLean || 'Not Applicable';
        
        // Force numbers
        const toNum = (v) => Math.round(Number(v) || 0);
        parsed.biasScore = toNum(parsed.biasScore);
        parsed.credibilityScore = toNum(parsed.credibilityScore);
        parsed.reliabilityScore = toNum(parsed.reliabilityScore);
        
        // Trust Score Logic
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
