// services/geminiService.js
const axios = require('axios');

class GeminiService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize usage trackers
    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });
  }

  loadApiKeys() {
    // Supports GEMINI_API_KEY_1 ... GEMINI_API_KEY_20 in your .env
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`];
      if (key) keys.push(key);
    }
    // Allows a fallback default key
    if (keys.length === 0 && process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
    if (keys.length === 0) throw new Error('No Gemini API keys provided!');
    return keys;
  }

  // Round-robin Gemini API key selection, skipping keys with repeated errors
  getNextApiKey() {
    if (!this.apiKeys.length) throw new Error('No Gemini API keys available');
    const maxErrors = 5; // could be tuned
    let checked = 0;
    while (checked < this.apiKeys.length) {
      const key = this.apiKeys[this.currentKeyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      if (errorCount < maxErrors) return key;
      checked++;
    }
    // If all keys have errors, reset error counts
    this.apiKeys.forEach(key => this.keyErrorCount.set(key, 0));
    return this.apiKeys[0];
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
  }
  recordError(apiKey) {
    this.keyErrorCount.set(apiKey, (this.keyErrorCount.get(apiKey) || 0) + 1);
  }

  // Main analysis function with automatic retries and API key rotation
  async analyzeArticle(article, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const apiKey = this.getNextApiKey();
        const result = await this.makeAnalysisRequest(article, apiKey);
        this.recordSuccess(apiKey);
        return result;
      } catch (err) {
        lastError = err;
        // Optionally: record error for this key
      }
    }
    throw lastError;
  }

  async makeAnalysisRequest(article, apiKey) {
    const prompt = this.buildEnhancedPrompt(article);
   const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    try {
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 2048
          }
        },
        { timeout: 30000 }
      );
      return this.parseAnalysisResponse(response.data);
    } catch (err) {
      this.recordError(apiKey);
      throw err;
    }
  }

  buildEnhancedPrompt(article) {
    // This is the updated prompt
    return `You are an expert news analyst. Analyze this news article. Return ONLY valid JSON (no markdown, no explanations).

Article Title: ${article.title}
Description: ${article.description || ''}

INSTRUCTIONS:
1.  First, determine the article type. Is it 'Full' (hard news: politics, economy, etc.) or 'SentimentOnly' (subjective reviews: tech, car, movie reviews, opinions, etc.)?
2.  Second, determine the 'sentiment' (Positive, Negative, Neutral) of the article towards its main topic.
3.  If 'analysisType' is 'Full', provide all bias, credibility, and reliability scores as numbers.
4.  If 'analysisType' is 'SentimentOnly', set *all* scores (biasScore, credibilityScore, etc.) and component scores (linguistic, sourceSelection, etc.) to 0.

Return detailed multifactor analysis (see example structure):

{
  "summary": "exactly 60 words summary",
  "category": "Politics/Economy/Technology/Health/Environment/Justice/Education/Entertainment/Sports",
  "politicalLean": "Left/Left-Leaning/Center/Right-Leaning/Right",
  
  "analysisType": "Full",
  "sentiment": "Negative",

  "biasScore": 44,
  "biasLabel": "Low Bias/Moderate/High/Extreme",
  "biasComponents": {
    "linguistic": {
      "sentimentPolarity": 38,
      "emotionalLanguage": 35,
      "loadedTerms": 42,
      "complexityBias": 40
    },
    "sourceSelection": {
      "sourceDiversity": 55,
      "expertBalance": 53,
      "attributionTransparency": 74
    },
    "demographic": {
      "genderBalance": 60,
      "racialBalance": 56,
      "ageRepresentation": 52
    },
    "framing": {
      "headlineFraming": 47,
      "storySelection": 54,
      "omissionBias": 39
    }
  },

  "credibilityScore": 87,
  "credibilityGrade": "A/A+/A-/B+/B/B-/C+/C/C-/D/F",
  "credibilityComponents": {
    "sourceCredibility": 88,
    "factVerification": 90,
    "professionalism": 84,
    "evidenceQuality": 80,
    "transparency": 88,
    "audienceTrust": 78
  },

  "reliabilityScore": 93,
  "reliabilityGrade": "A+",
  "reliabilityComponents": {
    "consistency": 95,
    "temporalStability": 92,
    "qualityControl": 94,
    "publicationStandards": 90,
    "correctionsPolicy": 88,
    "updateMaintenance": 89
  },

  "trustScore": 90,
  "trustLevel": "Highly Trustworthy/Very Trustworthy/Trustworthy/Moderately Trustworthy/Questionable/Low Trust",

  "coverageLeft": 33,
  "coverageCenter": 35,
  "coverageRight": 32,
  "clusterId": 5,

  "keyFindings": [
    "key insight 1",
    "key insight 2"
  ],
  "recommendations": [
    "User should crosscheck with alternate sources for more context",
    "Bias is low but fact verification recommended"
  ]
}

IMPORTANT: Output ONLY the JSON, no extra explanations. For a 'SentimentOnly' article, all score fields *must* be 0.`;
  }

  // This is the NEW, robust function
parseAnalysisResponse(data) {
  try {
    // --- NEW SAFETY CHECK ---
    // Checks if the API was blocked (e.g., safety reasons) or returned an error
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      const blockReason = data.promptFeedback?.blockReason || 'Unknown error (no candidate array)';
      throw new Error(`API block or error: ${blockReason}`);
    }
    // --- END NEW CHECK ---

    const text = data.candidates[0].content.parts[0].text;
    let jsonText = text.trim();

    // Fix for 'Unexpected end of JSON input'
    if (jsonText.length === 0) {
      throw new Error('Received empty text response from API');
    }

    jsonText = jsonText.replace(/``````/g, '');
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
       // Log the bad response for debugging
       console.error("Gemini response did not contain JSON:", text);
       throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Ensure required fields exist
    if (!parsed.summary) throw new Error('Missing required field: summary');
    if (!parsed.sentiment) parsed.sentiment = 'Neutral'; // Default sentiment
    if (!parsed.analysisType) parsed.analysisType = 'Full'; // Default type

    // Calculate trustScore if missing (and if it's a 'Full' analysis)
    if (parsed.analysisType === 'Full' && !parsed.trustScore && parsed.credibilityScore && parsed.reliabilityScore) {
      parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
    } else if (parsed.analysisType === 'SentimentOnly') {
      // Ensure all scores are 0 if it's a review
      parsed.biasScore = 0;
      parsed.credibilityScore = 0;
      parsed.reliabilityScore = 0;
      parsed.trustScore = 0;
      parsed.politicalLean = 'Center'; // Reviews don't have a lean
    }

    return parsed;
  } catch (err) {
    // This will now pass a cleaner error message up
    throw new Error('Error parsing Gemini response: ' + err.message);
  }
}
      
      // Ensure required fields exist
      if (!parsed.summary) throw new Error('Missing required field: summary');
      if (!parsed.sentiment) parsed.sentiment = 'Neutral'; // Default sentiment
      if (!parsed.analysisType) parsed.analysisType = 'Full'; // Default type
      
      // Calculate trustScore if missing (and if it's a 'Full' analysis)
      if (parsed.analysisType === 'Full' && !parsed.trustScore && parsed.credibilityScore && parsed.reliabilityScore) {
        parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
      } else if (parsed.analysisType === 'SentimentOnly') {
        // Ensure all scores are 0 if it's a review
        parsed.biasScore = 0;
        parsed.credibilityScore = 0;
        parsed.reliabilityScore = 0;
        parsed.trustScore = 0;
        parsed.politicalLean = 'Center'; // Reviews don't have a lean
      }

      return parsed;
    } catch (err) {
      throw new Error('Error parsing Gemini response: ' + err.message);
    }
  }

  getStatistics() {
    return {
      totalKeys: this.apiKeys.length,
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: key.substring(0, 10) + '...',
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    }
  }
}

module.exports = new GeminiService();
