// services/geminiService.js (FINAL v3.1 - Prompt Refactored)
const axios = require('axios');
// --- IMPORT THE NEW PROMPT FILE ---
const { getAnalysisPrompt } = require('../utils/prompts');

// --- Helper Functions ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- GeminiService Class ---
class GeminiService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();
    
    this.isRateLimited = false;

    // Initialize trackers
    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });
    console.log(`🤖 Gemini Service Initialized: ${this.apiKeys.length} API keys loaded.`);
  }

  // Load API keys from environment variables
  loadApiKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
      if (key) keys.push(key);
    }
    const defaultKey = process.env.GEMINI_API_KEY?.trim();
    if (keys.length === 0 && defaultKey) {
        keys.push(defaultKey);
        console.log("🔑 Using default GEMINI_API_KEY.");
    }
    if (keys.length === 0) console.warn("⚠️ No Gemini API keys found. Analysis may fail.");
    else console.log(`🔑 Loaded ${keys.length} Gemini API key(s).`);
    return keys;
  }

  // Get next available API key with rotation and error skipping
  getNextApiKey() {
    if (!this.apiKeys || this.apiKeys.length === 0) throw new Error('No Gemini API keys available.');

    const numKeys = this.apiKeys.length;
    const maxErrorsPerKey = 5; 
    let attempts = 0;

    while (attempts < numKeys) {
      const keyIndex = this.currentKeyIndex;
      const key = this.apiKeys[keyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;

      this.currentKeyIndex = (this.currentKeyIndex + 1) % numKeys; 

      if (errorCount < maxErrorsPerKey) {
        return key; 
      } else if (errorCount === maxErrorsPerKey) {
          console.warn(`⚠️ Temporarily skipping Gemini key ...${key.slice(-4)} (Index ${keyIndex}) due to ${errorCount} errors.`);
      }
      attempts++;
    }

    console.error(`🚨 All ${numKeys} Gemini keys hit error threshold (${maxErrorsPerKey}). Resetting counts.`);
    this.apiKeys.forEach(k => this.keyErrorCount.set(k, 0));
    this.currentKeyIndex = 1 % numKeys; 
    return this.apiKeys[0];
  }

  recordSuccess(apiKey) {
    if (apiKey && this.keyUsageCount.has(apiKey)) {
        this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
        if (this.keyErrorCount.get(apiKey) > 0) this.keyErrorCount.set(apiKey, 0);
        this.isRateLimited = false;
    }
  }

  recordError(apiKey, apiName = "Gemini") {
    if (apiKey && this.keyErrorCount.has(apiKey)) {
        const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
        this.keyErrorCount.set(apiKey, currentErrors);
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} is now ${currentErrors}`);
    }
  }

  // --- Main Analysis Function ---
  async analyzeArticle(article, maxRetries = 3) {
    if (!this.apiKeys || this.apiKeys.length === 0) throw new Error("Analysis failed: No Gemini keys configured.");

    let lastError = null;
    let apiKeyUsed = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        apiKeyUsed = this.getNextApiKey();
        const result = await this.makeAnalysisRequest(article, apiKeyUsed);
        this.recordSuccess(apiKeyUsed);
        return result; 

      } catch (error) {
        lastError = error;
        if (apiKeyUsed) this.recordError(apiKeyUsed);

        const status = error.response?.status;
        const isRetriable = (status === 503 || status === 429 || status >= 500);
        
        if (status === 429) {
            console.warn(`🐌 RATE LIMIT DETECTED. Enabling 'slow mode' throttle.`);
            this.isRateLimited = true;
        }

        if (isRetriable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.warn(`⏳ Gemini returned ${status}. Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        } else {
          console.error(`❌ Gemini analysis failed definitively after ${attempt} attempt(s). Msg: ${error.message}`);
          break; // Don't retry non-retriable errors (like 400 Bad Request)
        }
      }
    }
    throw lastError || new Error(`Gemini analysis failed after ${maxRetries} attempts.`);
  }

  // --- Generate Embedding Function ---
  async createEmbedding(text) {
      if (!text || typeof text !== 'string') return null;
      
      const apiKey = this.getNextApiKey();
      // Use text-embedding-004 model
      const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;

      try {
          // Truncate text to avoid token limits (max 2048 tokens usually safe)
          const safeText = text.substring(0, 8000); 

          const response = await axios.post(url, {
              content: { parts: [{ text: safeText }] },
              taskType: "CLUSTERING" // Optimizes embedding for clustering tasks
          });

          if (response.data && response.data.embedding && response.data.embedding.values) {
              this.recordSuccess(apiKey);
              return response.data.embedding.values; // Returns array of numbers
          }
          return null;
      } catch (error) {
          console.error(`❌ Embedding generation failed: ${error.message}`);
          // We don't throw here to avoid stopping the whole process, just return null
          return null;
      }
  }

  // --- Make Single API Request ---
  async makeAnalysisRequest(article, apiKey) {
    if (!apiKey) throw new Error("Internal error: apiKey missing");

    // --- UPDATED: Use the imported prompt generator ---
    const prompt = getAnalysisPrompt(article);
    // ------------------------------------------------

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    try {
      const response = await axios.post(
        url,
        {
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
        },
        { timeout: 60000, validateStatus: (status) => status >= 200 && status < 300 }
      );

      return this.parseAnalysisResponse(response.data);

    } catch (error) {
       if (error.response) {
            console.error(`❌ Gemini API HTTP Error: Status ${error.response.status}`);
            throw new Error(`Gemini API request failed with HTTP status ${error.response.status}`);
        } else {
            throw new Error(`Gemini API request failed: ${error.message}`);
        }
    }
  }

  // --- Parse Response ---
  parseAnalysisResponse(data) {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates returned');
        
        let text = data.candidates[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response text');

        // 1. Sanitize Markdown
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // 2. Extract JSON if buried in text
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            text = text.substring(jsonStart, jsonEnd + 1);
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            console.warn("⚠️ JSON Parse failed, attempting simple repair...");
            text = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            parsed = JSON.parse(text);
        }

        // Apply Defaults to prevent UI crashes
        parsed.summary = parsed.summary || 'Summary unavailable';
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        parsed.sentiment = ['Positive', 'Negative', 'Neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral';
        parsed.politicalLean = parsed.politicalLean || 'Center';
        parsed.category = parsed.category || 'Other';
        parsed.isJunk = (parsed.isJunk === 'Yes' || parsed.isJunk === true);
        parsed.clusterTopic = parsed.clusterTopic || null;
        parsed.country = ['USA', 'India'].includes(parsed.country) ? parsed.country : 'Global';

        // Ensure Scores are Numbers
        const parseScore = (s) => (parsed.analysisType === 'SentimentOnly' ? 0 : Math.round(Number(s) || 0));
        parsed.biasScore = parseScore(parsed.biasScore);
        parsed.credibilityScore = parseScore(parsed.credibilityScore);
        parsed.reliabilityScore = parseScore(parsed.reliabilityScore);
        
        // Trust Score Calculation
        parsed.trustScore = 0;
        if (parsed.analysisType === 'Full' && parsed.credibilityScore > 0) {
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }

        parsed.keyFindings = Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [];
        parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

        return parsed;

    } catch (error) {
        console.error(`❌ Parser Error: ${error.message}`);
        throw new Error(`Failed to parse Gemini response: ${error.message}`);
    }
  }

  getStatistics() {
    return {
      totalKeysLoaded: this.apiKeys.length,
      currentKeyIndex: this.currentKeyIndex
    };
  }
}

module.exports = new GeminiService();
