// services/geminiService.js (FINAL v2.14 - 5-Field Clustering)
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
    const maxErrorsPerKey = 5; // Skip key after 5 consecutive errors
    let attempts = 0;

    while (attempts < numKeys) {
      const keyIndex = this.currentKeyIndex;
      const key = this.apiKeys[keyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;

      this.currentKeyIndex = (this.currentKeyIndex + 1) % numKeys; // Cycle for next call

      if (errorCount < maxErrorsPerKey) {
        return key; // Found usable key
      } else if (errorCount === maxErrorsPerKey) { // Log skip only once
          console.warn(`⚠️ Temporarily skipping Gemini key ...${key.slice(-4)} (Index ${keyIndex}) due to ${errorCount} errors.`);
      }
      attempts++;
    }

    // All keys skipped - reset counts and use first key
    console.error(`🚨 All ${numKeys} Gemini keys hit error threshold (${maxErrorsPerKey}). Resetting counts.`);
    this.apiKeys.forEach(k => this.keyErrorCount.set(k, 0));
    this.currentKeyIndex = 1 % numKeys; // Prepare for next cycle
    return this.apiKeys[0];
  }

  // Record success and reset error count
  recordSuccess(apiKey, apiName = "Gemini") {
    if (apiKey && this.keyUsageCount.has(apiKey)) {
        this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
        if (this.keyErrorCount.get(apiKey) > 0) this.keyErrorCount.set(apiKey, 0);
    }
  }

  // Record error for a key
  recordError(apiKey, apiName = "Gemini") {
    if (apiKey && this.keyErrorCount.has(apiKey)) {
        const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
        this.keyErrorCount.set(apiKey, currentErrors);
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} is now ${currentErrors}`);
    } else if (apiKey) {
        console.warn(`📈 Tried to record error for unknown ${apiName} key ...${apiKey.slice(-4)}`);
    } else {
        console.warn(`📈 Tried to record ${apiName} error, but API key was invalid.`);
    }
  }

  // --- Main Analysis Function with Retries ---
  async analyzeArticle(article, maxRetries = 3) {
    if (!this.apiKeys || this.apiKeys.length === 0) throw new Error("Analysis failed: No Gemini keys configured.");

    let lastError = null;
    let apiKeyUsed = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        apiKeyUsed = this.getNextApiKey();
        const result = await this.makeAnalysisRequest(article, apiKeyUsed);
        this.recordSuccess(apiKeyUsed);
        return result; // Success!

      } catch (error) {
        lastError = error;
        if (apiKeyUsed) this.recordError(apiKeyUsed); // Record error for the key used

        const status = error.response?.status;
        const isRetriable = (status === 503 || status === 429); // Retry on Service Unavailable or Rate Limit

        if (isRetriable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // Exponential backoff
          console.warn(`⏳ Gemini returned ${status}. Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        } else {
          console.error(`❌ Gemini analysis failed definitively after ${attempt} attempt(s) for article: "${article?.title?.substring(0, 60)}..."`);
          break; // Exit retry loop
        }
      }
    } // End loop

    // If loop finishes, throw the last error
    throw lastError || new Error(`Gemini analysis failed after ${maxRetries} attempts.`);
  }

  // --- Make Single API Request ---
  async makeAnalysisRequest(article, apiKey) {
    if (!apiKey) throw new Error("Internal error: apiKey missing for makeAnalysisRequest");

    const prompt = this.buildEnhancedPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    try {
      const response = await axios.post(
        url,
        { // Request Body
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json", // --- NEW: Force JSON output ---
            temperature: 0.4,
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 4096 
          },
          // --- SAFETY SETTINGS: BLOCK_NONE ---
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        },
        { // Axios Config
            timeout: 60000, // 60 second timeout
            responseType: 'json', // Expect JSON response
            validateStatus: (status) => status >= 200 && status < 300, // Only 2xx are success
        }
      );

      if (!response.data || typeof response.data !== 'object') {
          throw new Error("Received invalid response data from Gemini API despite 2xx status.");
      }
      // --- MODIFIED: Pass data directly to parser ---
      return this.parseAnalysisResponse(response.data);

    } catch (error) {
        if (error.response) { // Server responded with non-2xx status
            console.error(`❌ Gemini API HTTP Error: Status ${error.response.status}`, error.response.data);
            if (error.response.status === 503 || error.response.status === 429) {
                error.message = `Gemini API returned status ${error.response.status}`; // For retry logic
                throw error;
            }
            throw new Error(`Gemini API request failed with HTTP status ${error.response.status}`);
        } else if (error.request) { // No response received
            console.error('❌ Gemini API Network Error: No response.', error.message);
            throw new Error(`Gemini API request failed: No response (check network/timeout).`);
        } else { // Setup error
            console.error('❌ Gemini API Setup Error:', error.message);
            throw new Error(`Gemini API request setup failed: ${error.message}`);
        }
    }
  }

  // --- Build Prompt ---
  buildEnhancedPrompt(article) {
    const title = article?.title || "No Title";
    const description = article?.description || "No Description";

    // --- CRITICAL CONTEXT INJECTION ---
    const currentDate = "October 30, 2025"; // Updated date
    const currentUSPresident = "Donald Trump";
    // ---------------------------------

    return `CURRENT_CONTEXT: Today's date is ${currentDate}. The current President of the United States is ${currentUSPresident}. All analysis must reflect this present reality.

Analyze the news article (Title: "${title}", Description: "${description}"). Return ONLY a valid JSON object.

INSTRUCTIONS:
1. 'analysisType': 'Full' for hard news (politics, economy, justice). 'SentimentOnly' for opinions, reviews, sports, or product announcements.
2. 'sentiment': 'Positive', 'Negative', or 'Neutral' (Reflecting the article's overall sentiment towards the main *subject*).
3. 'isJunk': 'Yes' if the article is promotional, sponsored content, an ad, or not a real news story. Otherwise, 'No'.

**--- CLUSTERING FIELDS (CRITICAL) ---**
4. 'clusterTopic' (Event): A 5-7 word generic topic for the core news event (e.g., 'US Election Polls Q3', 'Ukraine Peace Summit', 'New iPhone Launch'). Null if not a news event.
5. 'country' (Primary Country): 
   - If the story is primarily about the USA, return "USA".
   - If the story is primarily about India, return "India".
   - For ALL other countries or global events, return "Global".
6. 'primaryNoun' (Main Noun): The single, most important proper noun (person, organization, or place) in the article. If none, return null.
7. 'secondaryNoun' (Second Noun): The second most important proper noun. This can be a person, organization, or a country name (e.g., "Japan", "Cambodia"). If none, return null.

8. If 'Full': Provide scores (0-100) for bias, credibility, reliability, and all components. Assign labels/grades.
9. If 'SentimentOnly': Set ALL numerical scores (biasScore, credibilityScore, reliabilityScore, ALL component scores) strictly to 0. Set politicalLean to 'Not Applicable'.

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
  "biasComponents": {"linguistic": {"sentimentPolarity": 50,...}, "sourceSelection": {...}, "demographic": {...}, "framing": {...}},
  "credibilityScore": 75, "credibilityGrade": "B",
  "credibilityComponents": {"sourceCredibility": 70, "factVerification": 80, "professionalism": 75, "evidenceQuality": 85, "transparency": 60, "audienceTrust": 65},
  "reliabilityScore": 80, "reliabilityGrade": "B+",
  "reliabilityComponents": {"consistency": 80, "temporalStability": 70, "qualityControl": 85, "publicationStandards": 90, "correctionsPolicy": 75, "updateMaintenance": 60},
  "trustLevel": "Trustworthy",
  "coverageLeft": 33, "coverageCenter": 34, "coverageRight": 33,
  "keyFindings": ["Finding 1.", "Finding 2."],
  "recommendations": ["Rec 1.", "Rec 2."]
}

Output ONLY the JSON object.`;
  }

  // --- Parse and Validate Response ---
  parseAnalysisResponse(data) {
    try {
        // 1. Check Safety Blocks / API Errors
        if (!data.candidates || data.candidates.length === 0) {
            const blockReason = data.promptFeedback?.blockReason || 'No candidates';
            console.error(`❌ Parser Error: Response blocked or no candidates. Reason: ${blockReason}`, data.promptFeedback?.safetyRatings);
            throw new Error(`API Response Error: ${blockReason}`);
        }
        const candidate = data.candidates[0];

        // 2. Check Candidate Finish Reason
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`⚠️ Parser Warning: Candidate finishReason: ${candidate.finishReason}. Content may be partial.`, candidate.safetyRatings);
            if (candidate.finishReason === 'SAFETY') throw new Error(`API Response Blocked: Candidate stopped for SAFETY`);
            if (!candidate.content?.parts?.[0]?.text) throw new Error(`Candidate stopped for ${candidate.finishReason} and has no text.`);
        }

        // 3. Extract Text (This is now the JSON object itself)
        const parsed = candidate.content?.parts?.[0]?.text;
        if (typeof parsed !== 'object' || parsed === null) {
             // Fallback for older models that might still wrap in text/markdown
             const text = candidate.content?.parts?.[0]?.text;
             if (typeof text === 'string' && text.trim()) {
                 const jsonMatch = text.trim().match(/(?:```json)?\s*(\{[\s\S]*\})\s*(?:```)?/);
                 if (!jsonMatch?.[1]) throw new Error('No valid JSON object found in response text');
                 parsed = JSON.parse(jsonMatch[1]); // Will throw on invalid JSON
             } else {
                 throw new Error('Response candidate missing valid JSON content');
             }
        }
        
        // 4. Validate & Apply Defaults
        if (typeof parsed !== 'object' || parsed === null) throw new Error('Parsed content is not a valid object');

        // Required fields with defaults
        parsed.summary = (typeof parsed.summary === 'string' && parsed.summary.trim()) ? parsed.summary.trim() : 'Summary unavailable';
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        const isSentimentOnly = parsed.analysisType === 'SentimentOnly';
        parsed.sentiment = ['Positive', 'Negative', 'Neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral';
        const defaultLean = isSentimentOnly ? 'Not Applicable' : 'Center';
        parsed.politicalLean = ['Left', 'Left-Leaning', 'Center', 'Right-Leaning', 'Right', 'Not Applicable'].includes(parsed.politicalLean) ? parsed.politicalLean : defaultLean;
        parsed.category = (typeof parsed.category === 'string' && parsed.category.trim()) ? parsed.category.trim() : 'General';
        
        // --- NEW CLUSTERING FIELDS ---
        parsed.isJunk = (parsed.isJunk === 'Yes' || parsed.isJunk === true); // Coerce to boolean
        parsed.clusterTopic = (typeof parsed.clusterTopic === 'string' && parsed.clusterTopic.trim()) ? parsed.clusterTopic.trim() : null;
        // Apply Country rule
        parsed.country = ['USA', 'India'].includes(parsed.country) ? parsed.country : 'Global';
        // Parse Nouns (set to null if empty string)
        parsed.primaryNoun = (typeof parsed.primaryNoun === 'string' && parsed.primaryNoun.trim()) ? parsed.primaryNoun.trim() : null;
        parsed.secondaryNoun = (typeof parsed.secondaryNoun === 'string' && parsed.secondaryNoun.trim()) ? parsed.secondaryNoun.trim() : null;
        // --- END NEW FIELDS ---


        // Function to safely parse score (0-100), returns 0 if invalid or SentimentOnly
        const parseScore = (score) => {
             if (isSentimentOnly) return 0;
             const num = Number(score);
             return !isNaN(num) && num >= 0 && num <= 100 ? Math.round(num) : 0;
        };

        // Scores
        parsed.biasScore = parseScore(parsed.biasScore);
        parsed.credibilityScore = parseScore(parsed.credibilityScore);
        parsed.reliabilityScore = parseScore(parsed.reliabilityScore);
        
        // --- TRUST SCORE CALCULATION (from PDF) ---
        parsed.trustScore = 0; // Default
        if (!isSentimentOnly && parsed.credibilityScore > 0 && parsed.reliabilityScore > 0) {
            // OTS = sqrt(UCS * URS)
            parsed.trustScore = Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
        }
        // --- End Trust Score Calculation ---

        // Components (ensure objects exist, parse nested scores)
        const ensureObject = (obj) => typeof obj === 'object' && obj !== null ? obj : {};
        const parseComponentScores = (compObj) => {
            if (!compObj) return {};
            for (const key in compObj) {
                if (Object.hasOwnProperty.call(compObj, key)) {
                     compObj[key] = parseScore(compObj[key]); // Apply score parsing to all component values
                }
            }
            return compObj;
        };

        parsed.biasComponents = ensureObject(parsed.biasComponents);
        parsed.biasComponents.linguistic = parseComponentScores(ensureObject(parsed.biasComponents.linguistic));
        parsed.biasComponents.sourceSelection = parseComponentScores(ensureObject(parsed.biasComponents.sourceSelection));
        parsed.biasComponents.demographic = parseComponentScores(ensureObject(parsed.biasComponents.demographic));
        parsed.biasComponents.framing = parseComponentScores(ensureObject(parsed.biasComponents.framing));

        parsed.credibilityComponents = parseComponentScores(ensureObject(parsed.credibilityComponents));
        parsed.reliabilityComponents = parseComponentScores(ensureObject(parsed.reliabilityComponents));

        // Ensure arrays exist
        parsed.keyFindings = Array.isArray(parsed.keyFindings) ? parsed.keyFindings.map(String) : []; // Ensure strings
        parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [];

        // Optional fields - ensure correct type or set to undefined
        parsed.biasLabel = typeof parsed.biasLabel === 'string' ? parsed.biasLabel : undefined;
        parsed.credibilityGrade = typeof parsed.credibilityGrade === 'string' ? parsed.credibilityGrade : undefined;
        parsed.reliabilityGrade = typeof parsed.reliabilityGrade === 'string' ? parsed.reliabilityGrade : undefined;
        parsed.trustLevel = typeof parsed.trustLevel === 'string' ? parsed.trustLevel : undefined;
        parsed.coverageLeft = typeof parsed.coverageLeft === 'number' ? parsed.coverageLeft : undefined;
        parsed.coverageCenter = typeof parsed.coverageCenter === 'number' ? parsed.coverageCenter : undefined;
        parsed.coverageRight = typeof parsed.coverageRight === 'number' ? parsed.coverageRight : undefined;
        
        return parsed; // Return validated object

    } catch (error) {
        console.error(`❌ Error during Gemini response parsing/validation: ${error.message}`);
        // Log the raw data only if not in production for security/privacy
        if (process.env.NODE_ENV !== 'production') {
             console.error("--- Raw Response Data ---");
             console.error(JSON.stringify(data, null, 2)); // Log formatted full data
             console.error("--- End Raw Data ---");
        }
        throw new Error(`Failed to process Gemini response: ${error.message}`);
    }
  }

  // --- Get Statistics ---
  getStatistics() {
    const loadedKeys = this.apiKeys || [];
    return {
      totalKeysLoaded: loadedKeys.length,
      currentKeyIndex: this.currentKeyIndex,
      keyStatus: loadedKeys.map((key, index) => ({
        index: index,
        keyLast4: key ? `...${key.slice(-4)}` : 'N/A', // Handle potentially null keys
        usage: key ? (this.keyUsageCount.get(key) || 0) : 0,
        consecutiveErrors: key ? (this.keyErrorCount.get(key) || 0) : 0
      }))
    };
  }
}

module.exports = new GeminiService();
