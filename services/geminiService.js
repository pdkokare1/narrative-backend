// services/geminiService.js (FINAL v2.17 - Added Embeddings)
const axios = require('axios');

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
        const isRetriable = (status === 503 || status === 429);
        
        if (status === 429) {
            console.warn(`🐌 RATE LIMIT DETECTED. Enabling 'slow mode' throttle.`);
            this.isRateLimited = true;
        }

        if (isRetriable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.warn(`⏳ Gemini returned ${status}. Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        } else {
          console.error(`❌ Gemini analysis failed definitively after ${attempt} attempt(s).`);
          break;
        }
      }
    }
    throw lastError || new Error(`Gemini analysis failed after ${maxRetries} attempts.`);
  }

  // --- NEW: Generate Embedding Function ---
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

    const prompt = this.buildEnhancedPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    try {
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 4096 
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
       // Error handling logic identical to before
       if (error.response) {
            console.error(`❌ Gemini API HTTP Error: Status ${error.response.status}`);
            throw new Error(`Gemini API request failed with HTTP status ${error.response.status}`);
        } else {
            throw new Error(`Gemini API request failed: ${error.message}`);
        }
    }
  }

  // --- Build Prompt ---
  buildEnhancedPrompt(article) {
    const title = article?.title || "No Title";
    const description = article?.description || "No Description";
    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

    return `CURRENT_CONTEXT: Today's date is ${currentDate}. All analysis must be based on this date.

Analyze the news article (Title: "${title}", Description: "${description}"). Return ONLY a valid JSON object.

INSTRUCTIONS:
1. 'analysisType': 'Full' for hard news. 'SentimentOnly' for opinions/reviews.
2. 'sentiment': 'Positive', 'Negative', or 'Neutral'.
3. 'isJunk': 'Yes' if promotional/ad/spam. Otherwise 'No'.

**--- CLUSTERING FIELDS ---**
4. 'clusterTopic': A 5-7 word generic topic (e.g., 'US Election Polls', 'iPhone Launch'). Null if not a specific event.
5. 'country': 'USA', 'India', or 'Global'.
6. 'primaryNoun': Main proper noun (Person/Org).
7. 'secondaryNoun': Second proper noun.

8. If 'Full': Provide scores (0-100) for bias, credibility, reliability.
9. If 'SentimentOnly': Set all scores to 0, politicalLean to 'Not Applicable'.

JSON Structure:
{
  "summary": "Neutral summary (exactly 60 words).",
  "category": "Politics/Economy/Technology/Health/Environment/Justice/Education/Entertainment/Sports/Other",
  "politicalLean": "Left/Left-Leaning/Center/Right-Leaning/Right/Not Applicable",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "isJunk": "No",
  "clusterTopic": "US-China Trade Talks",
  "country": "Global",
  "primaryNoun": "Donald Trump",
  "secondaryNoun": "Xi Jinping",
  "biasScore": 50, "biasLabel": "Moderate",
  "biasComponents": {"linguistic": {"sentimentPolarity": 50}, "sourceSelection": {}, "demographic": {}, "framing": {}},
  "credibilityScore": 75, "credibilityGrade": "B",
  "credibilityComponents": {"sourceCredibility": 70, "factVerification": 80, "professionalism": 75, "evidenceQuality": 85, "transparency": 60, "audienceTrust": 65},
  "reliabilityScore": 80, "reliabilityGrade": "B+",
  "reliabilityComponents": {"consistency": 80, "temporalStability": 70, "qualityControl": 85, "publicationStandards": 90, "correctionsPolicy": 75, "updateMaintenance": 60},
  "trustLevel": "Trustworthy",
  "coverageLeft": 33, "coverageCenter": 34, "coverageRight": 33,
  "keyFindings": ["Finding 1."],
  "recommendations": ["Rec 1."]
}

Output ONLY the JSON object.`;
  }

  // --- Parse Response ---
  parseAnalysisResponse(data) {
    try {
        if (!data.candidates || data.candidates.length === 0) throw new Error('No candidates returned');
        
        let parsed = data.candidates[0]?.content?.parts?.[0]?.text;
        
        // Clean markdown if present
        if (typeof parsed === 'string') {
             const jsonMatch = parsed.trim().match(/(?:```json)?\s*(\{[\s\S]*\})\s*(?:```)?/);
             if (jsonMatch?.[1]) parsed = JSON.parse(jsonMatch[1]);
        }
        
        if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid JSON');

        // Apply Defaults
        parsed.summary = parsed.summary || 'Summary unavailable';
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        parsed.sentiment = ['Positive', 'Negative', 'Neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral';
        parsed.politicalLean = parsed.politicalLean || 'Center';
        parsed.category = parsed.category || 'General';
        parsed.isJunk = (parsed.isJunk === 'Yes' || parsed.isJunk === true);
        parsed.clusterTopic = parsed.clusterTopic || null;
        parsed.country = ['USA', 'India'].includes(parsed.country) ? parsed.country : 'Global';
        parsed.primaryNoun = parsed.primaryNoun || null;
        parsed.secondaryNoun = parsed.secondaryNoun || null;

        // Ensure Scores are Numbers
        const parseScore = (s) => (parsed.analysisType === 'SentimentOnly' ? 0 : Math.round(Number(s) || 0));
        parsed.biasScore = parseScore(parsed.biasScore);
        parsed.credibilityScore = parseScore(parsed.credibilityScore);
        parsed.reliabilityScore = parseScore(parsed.reliabilityScore);
        
        // Trust Score
        parsed.trustScore = 0;
        if (parsed.analysisType === 'Full' && parsed.credibilityScore > 0) {
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }

        // Arrays
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
