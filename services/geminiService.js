// services/geminiService.js (FINAL VERSION - Includes 503 retry and safer parser)
const axios = require('axios');

// Helper function for sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class GeminiService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize trackers
    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });
    console.log(`🤖 GeminiService initialized with ${this.apiKeys.length} API keys.`);
  }

  loadApiKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.GEMINI_API_KEY) {
        keys.push(process.env.GEMINI_API_KEY);
    }
    if (keys.length === 0) {
        console.error("🚨 CRITICAL: No Gemini API keys found in environment variables!");
        throw new Error('No Gemini API keys provided!');
    }
    return keys;
  }

  getNextApiKey() {
    if (!this.apiKeys.length) throw new Error('No Gemini API keys available');
    const maxErrorsPerKey = 5; // Max consecutive errors before temporarily skipping a key
    let attempts = 0;

    while (attempts < this.apiKeys.length) {
      const keyIndex = this.currentKeyIndex;
      const key = this.apiKeys[keyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;

      // Move to next key for next time
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;

      if (errorCount < maxErrorsPerKey) {
        // console.log(`🔑 Using Gemini Key index ${keyIndex}`); // Uncomment for debugging key rotation
        return key; // Found a usable key
      } else {
          console.warn(`⚠️ Temporarily skipping Gemini key index ${keyIndex} due to ${errorCount} errors.`);
      }
      attempts++;
    }

    // If all keys have too many errors, log a warning and reset errors for all keys
    console.error(`🚨 All Gemini keys have reached the error threshold (${maxErrorsPerKey}). Resetting error counts and retrying.`);
    this.apiKeys.forEach(key => this.keyErrorCount.set(key, 0));
    // Return the first key after reset
    this.currentKeyIndex = 0;
    return this.apiKeys[0];
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
    // Reset error count for this key on success
    this.keyErrorCount.set(apiKey, 0);
  }

  recordError(apiKey) {
    const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
    this.keyErrorCount.set(apiKey, currentErrors);
    console.warn(`📈 Increased error count for key ending in ...${apiKey.slice(-4)} to ${currentErrors}`);
  }

  // --- Main analysis function with retries for 503 errors ---
  async analyzeArticle(article, maxRetries = 3) {
    let lastError = null;
    let apiKey = ''; // Keep track of the key used in the last attempt

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        apiKey = this.getNextApiKey(); // Get a potentially usable key
        const result = await this.makeAnalysisRequest(article, apiKey);
        this.recordSuccess(apiKey); // Mark key as successful
        return result; // Got a result, exit loop

      } catch (err) {
        lastError = err; // Store the error
        this.recordError(apiKey); // Mark this key as having an error

        // Check if it's a retriable error (e.g., 503 or maybe 429 Rate Limit)
        const isRetriable = (err.response?.status === 503) || (err.response?.status === 429);

        if (isRetriable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // Exponential backoff with jitter
          console.warn(`⚠️ Gemini API returned ${err.response.status}. Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        } else {
            // Not a retriable error, or out of retries, break the loop and throw
            console.error(`❌ Gemini analysis failed after ${attempt} attempt(s) for article: ${article.title.substring(0, 60)}...`);
            break; // Exit loop, will throw lastError below
        }
      }
    }
    // If loop finished without returning, throw the last captured error
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
            temperature: 0.4, // Lower temp for more deterministic analysis
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 2048 // Sufficient for the JSON structure
          },
          // --- ADDED SAFETY SETTINGS ---
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
          // --- END SAFETY SETTINGS ---
        },
        {
            timeout: 45000, // Increased timeout to 45 seconds
            // Add adapter to handle potential proxy/network issues if necessary
            // adapter: require('axios/lib/adapters/http') // Example, might need npm install http
        }
      );
      // Check for empty or missing data before parsing
      if (!response || !response.data) {
          throw new Error("Received empty response from Gemini API");
      }
      return this.parseAnalysisResponse(response.data); // Pass full data object

    } catch (err) {
      // Axios wraps HTTP errors in err.response
      if (err.response) {
        console.error(`❌ Gemini API Error: Status ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        // Re-throw specific retriable errors for the retry logic
        if (err.response.status === 503 || err.response.status === 429) {
            throw err; // Let analyzeArticle handle retry
        }
        // For other client/server errors (4xx, 5xx), throw a more specific error
        throw new Error(`Gemini API request failed with status ${err.response.status}`);
      } else if (err.request) {
        // Request made but no response received (network issue, timeout)
        console.error('❌ Gemini API Error: No response received.', err.message);
        throw new Error(`Gemini API request failed: No response. ${err.message}`);
      } else {
        // Setup error or other issue
        console.error('❌ Gemini API Error: Request setup failed.', err.message);
        throw new Error(`Gemini API request setup failed: ${err.message}`);
      }
      // Note: recordError is called by analyzeArticle after catching
    }
  }

  buildEnhancedPrompt(article) {
    // --- PROMPT (No changes needed) ---
    return `You are an expert news analyst. Analyze this news article. Return ONLY valid JSON (no markdown, no explanations).

Article Title: ${article.title}
Description: ${article.description || ''}

INSTRUCTIONS:
1. First, determine the article type. Is it 'Full' (hard news: politics, economy, etc.) or 'SentimentOnly' (subjective reviews: tech, car, movie reviews, opinions, etc.)?
2. Second, determine the 'sentiment' (Positive, Negative, Neutral) of the article towards its main topic.
3. If 'analysisType' is 'Full', provide all bias, credibility, and reliability scores as numbers between 0 and 100.
4. If 'analysisType' is 'SentimentOnly', set *all* numerical score fields (biasScore, credibilityScore, reliabilityScore, trustScore, and all component scores like sentimentPolarity, sourceDiversity, etc.) to 0.

Return detailed multifactor analysis (use the exact structure below):

{
  "summary": "exactly 60 words summary",
  "category": "Politics/Economy/Technology/Health/Environment/Justice/Education/Entertainment/Sports/Other",
  "politicalLean": "Left/Left-Leaning/Center/Right-Leaning/Right/Not Applicable",
  "analysisType": "Full",
  "sentiment": "Positive/Negative/Neutral",
  "biasScore": 44,
  "biasLabel": "Low Bias/Moderate/High/Extreme",
  "biasComponents": {
    "linguistic": { "sentimentPolarity": 38, "emotionalLanguage": 35, "loadedTerms": 42, "complexityBias": 40 },
    "sourceSelection": { "sourceDiversity": 55, "expertBalance": 53, "attributionTransparency": 74 },
    "demographic": { "genderBalance": 60, "racialBalance": 56, "ageRepresentation": 52 },
    "framing": { "headlineFraming": 47, "storySelection": 54, "omissionBias": 39 }
  },
  "credibilityScore": 87,
  "credibilityGrade": "A+/A/A-/B+/B/B-/C+/C/C-/D/F",
  "credibilityComponents": { "sourceCredibility": 88, "factVerification": 90, "professionalism": 84, "evidenceQuality": 80, "transparency": 88, "audienceTrust": 78 },
  "reliabilityScore": 93,
  "reliabilityGrade": "A+/A/A-/B+/B/B-/C+/C/C-/D/F",
  "reliabilityComponents": { "consistency": 95, "temporalStability": 92, "qualityControl": 94, "publicationStandards": 90, "correctionsPolicy": 88, "updateMaintenance": 89 },
  "trustScore": 90,
  "trustLevel": "Highly Trustworthy/Very Trustworthy/Trustworthy/Moderately Trustworthy/Questionable/Low Trust/Not Applicable",
  "coverageLeft": 33,
  "coverageCenter": 35,
  "coverageRight": 32,
  "clusterId": 5,
  "keyFindings": ["key insight 1", "key insight 2"],
  "recommendations": ["User should crosscheck with alternate sources", "Fact verification recommended"]
}

IMPORTANT: Output ONLY the JSON object. Do not include markdown backticks (\`\`\`) or the word 'json'. For a 'SentimentOnly' article, all numerical score fields MUST be 0.`;
  }

  // --- FINAL, SAFEST PARSER ---
  parseAnalysisResponse(data) {
    // Check for safety blocks or other API-level issues first
    if (!data.candidates || data.candidates.length === 0) {
      const blockReason = data.promptFeedback?.blockReason || 'No candidates in response';
      const safetyRatings = data.promptFeedback?.safetyRatings || [];
      console.error(`❌ Gemini API Error: ${blockReason}. Safety Ratings: ${JSON.stringify(safetyRatings)}`);
      // It's helpful to log the full response if possible, but be careful with size/sensitive data
      // console.error("Full blocked response data:", JSON.stringify(data));
      throw new Error(`API block or error: ${blockReason}`);
    }

    // Check if the candidate itself finished due to safety or other reasons
    const candidate = data.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        // Reasons can be SAFETY, RECITATION, MAX_TOKENS, OTHER
        console.error(`❌ Gemini API Warning: Candidate finished due to ${candidate.finishReason}. Ratings: ${JSON.stringify(candidate.safetyRatings || [])}`);
        // If it's a safety block, we definitely don't have content
        if (candidate.finishReason === 'SAFETY') {
             throw new Error(`API block or error: Candidate stopped for SAFETY`);
        }
        // If MAX_TOKENS or RECITATION, content might be partial/unusable. Treat as error for now.
        // If OTHER, something unexpected happened.
        if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
             throw new Error(`Candidate finished with reason ${candidate.finishReason} but has no content.`);
        }
    }

    // Now, safely access the text content
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0 || !candidate.content.parts[0].text) {
         console.error("❌ Gemini API Error: Response candidate exists but has no text part.", JSON.stringify(candidate));
         throw new Error('Response candidate missing text content');
    }

    const text = candidate.content.parts[0].text;
    let jsonText = text.trim();

    if (jsonText.length === 0) {
      throw new Error('Received empty text response from API');
    }

    // Attempt to extract JSON even if there's extra text/markdown
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
       console.error("❌ Gemini response did not contain valid JSON structure:", jsonText);
       throw new Error('No JSON object found in response text');
    }

    try {
        const parsed = JSON.parse(jsonMatch[0]); // Try parsing only the matched block

        // --- VALIDATION AND DEFAULTS ---
        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error('Parsed content is not a JSON object');
        }
        if (!parsed.summary) throw new Error('Missing required field: summary');

        parsed.sentiment = parsed.sentiment || 'Neutral';
        parsed.analysisType = parsed.analysisType || 'Full';
        parsed.politicalLean = parsed.politicalLean || (parsed.analysisType === 'SentimentOnly' ? 'Not Applicable' : 'Center');


        // Default scores to 0 if missing or if SentimentOnly
        const isSentimentOnly = parsed.analysisType === 'SentimentOnly';
        parsed.biasScore = !isSentimentOnly ? (Number(parsed.biasScore) || 0) : 0;
        parsed.credibilityScore = !isSentimentOnly ? (Number(parsed.credibilityScore) || 0) : 0;
        parsed.reliabilityScore = !isSentimentOnly ? (Number(parsed.reliabilityScore) || 0) : 0;
        parsed.trustScore = !isSentimentOnly ? (Number(parsed.trustScore) || 0) : 0;

        // Default component objects and their nested scores if needed
        parsed.biasComponents = parsed.biasComponents || {};
        parsed.biasComponents.linguistic = parsed.biasComponents.linguistic || {};
        parsed.biasComponents.sourceSelection = parsed.biasComponents.sourceSelection || {};
        parsed.biasComponents.demographic = parsed.biasComponents.demographic || {};
        parsed.biasComponents.framing = parsed.biasComponents.framing || {};

        parsed.credibilityComponents = parsed.credibilityComponents || {};
        parsed.reliabilityComponents = parsed.reliabilityComponents || {};

        // Simplified check: if SentimentOnly, ensure components are zeroed (more robust needed if partial data possible)
        if (isSentimentOnly) {
            // A more thorough zeroing of nested component scores would go here if needed
        }

        // Calculate trustScore if needed (only for Full analysis)
        if (parsed.analysisType === 'Full' && parsed.trustScore === 0 && parsed.credibilityScore > 0 && parsed.reliabilityScore > 0) {
          parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
          console.log(`ℹ️ Calculated trustScore: ${parsed.trustScore}`);
        } else if (parsed.analysisType === 'SentimentOnly') {
             parsed.trustScore = 0; // Ensure it's zero
        }

        parsed.keyFindings = parsed.keyFindings || [];
        parsed.recommendations = parsed.recommendations || [];

        return parsed; // Return the validated and potentially defaulted object

    } catch (parseError) {
        console.error("❌ Error parsing JSON from Gemini response:", parseError.message);
        console.error("--- Raw JSON Text Attempted ---");
        console.error(jsonMatch ? jsonMatch[0] : jsonText); // Log what was attempted
        console.error("--- End Raw JSON Text ---");
        throw new Error(`Failed to parse JSON: ${parseError.message}`);
    }
  }

  getStatistics() {
    return {
      totalKeys: this.apiKeys.length,
      currentKeyIndex: this.currentKeyIndex, // Useful for debugging
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: `...${key.slice(-4)}`, // Show only last 4 chars
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    }
  }
}

module.exports = new GeminiService();
