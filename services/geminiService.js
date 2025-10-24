// services/geminiService.js (FINAL v2.8 - BLOCK_NONE, 8192 tokens, retry, component prompt)
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
    this.apiKeys.forEach(key => { // Initialize trackers
      this.keyUsageCount.set(key, 0); this.keyErrorCount.set(key, 0);
    });
    console.log(`🤖 Gemini Service Initialized: ${this.apiKeys.length} API keys loaded.`);
  }

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

  getNextApiKey() {
    if (!this.apiKeys || this.apiKeys.length === 0) throw new Error('No Gemini API keys available.');
    const numKeys = this.apiKeys.length;
    const maxErrorsPerKey = 5;
    let attempts = 0;
    while (attempts < numKeys) {
      const keyIndex = this.currentKeyIndex;
      const key = this.apiKeys[keyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;
      this.currentKeyIndex = (this.currentKeyIndex + 1) % numKeys; // Cycle index
      if (errorCount < maxErrorsPerKey) return key; // Usable key
      if (errorCount === maxErrorsPerKey) console.warn(`⚠️ Temporarily skipping Gemini key ...${key.slice(-4)} (Index ${keyIndex}) due to ${errorCount} errors.`);
      attempts++;
    }
    // All keys skipped
    console.error(`🚨 All ${numKeys} Gemini keys hit error threshold (${maxErrorsPerKey}). Resetting counts.`);
    this.apiKeys.forEach(k => this.keyErrorCount.set(k, 0));
    this.currentKeyIndex = 1 % numKeys; // Setup for next cycle
    return this.apiKeys[0]; // Use first key after reset
  }

  recordSuccess(apiKey, apiName = "Gemini") {
    if (apiKey && this.keyUsageCount.has(apiKey)) {
        this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
        if (this.keyErrorCount.get(apiKey) > 0) this.keyErrorCount.set(apiKey, 0);
    }
  }

  recordError(apiKey, apiName = "Gemini") {
    if (apiKey && this.keyErrorCount.has(apiKey)) {
        const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
        this.keyErrorCount.set(apiKey, currentErrors);
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} is now ${currentErrors}`);
    } else if (!apiKey) {
         console.warn(`📈 Tried to record ${apiName} error, but API key was missing.`);
    } // Don't warn for unknown keys
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
        if (apiKeyUsed) this.recordError(apiKeyUsed); // Record error only if key was valid
        const status = error.response?.status;
        const isRetriable = (status === 503 || status === 429);
        if (isRetriable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.warn(`⏳ Gemini returned ${status}. Retrying attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        } else {
          console.error(`❌ Gemini analysis failed definitively after ${attempt} attempt(s) for article: "${article?.title?.substring(0, 60)}..."`);
          break; // Exit retry loop
        }
      }
    }
    // Throw final error
    const finalMsg = `Gemini analysis failed after ${maxRetries} attempts for "${article?.title?.substring(0, 60)}...": ${lastError?.message || 'Unknown final error'}`;
    throw new Error(finalMsg);
  }

  // --- Make Single API Request ---
  async makeAnalysisRequest(article, apiKey) {
    if (!apiKey) throw new Error("Internal: apiKey missing for makeAnalysisRequest");

    const prompt = this.buildEnhancedPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    try {
      const response = await axios.post(
        url,
        { // Request Body
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4, topK: 32, topP: 0.95,
            // --- INCREASED TOKEN LIMIT ---
            maxOutputTokens: 8192 // Maximize output tokens
          },
          safetySettings: [ // BLOCK_NONE settings
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        },
        { // Axios Config
            timeout: 90000, // 90 second timeout
            responseType: 'json',
            validateStatus: (status) => status >= 200 && status < 300,
        }
      );

      if (!response.data || typeof response.data !== 'object') {
          throw new Error("Invalid/empty response data despite 2xx status.");
      }
      return this.parseAnalysisResponse(response.data);

    } catch (error) { // Error Handling
        if (error.response) {
            console.error(`❌ Gemini HTTP Error: Status ${error.response.status}`, error.response.data);
            if (error.response.status === 503 || error.response.status === 429) {
                error.message = `Gemini API returned status ${error.response.status}`; throw error;
            }
            throw new Error(`Gemini request failed (HTTP ${error.response.status})`);
        } else if (error.request) {
            console.error('❌ Gemini Network Error:', error.message);
            throw new Error(`Gemini request failed: No response (check network/timeout).`);
        } else {
            console.error('❌ Gemini Setup Error:', error.message);
            throw new Error(`Gemini request setup failed: ${error.message}`);
        }
    }
  }

  // --- Build Prompt for Component Scores ---
  buildEnhancedPrompt(article) {
    const title = article?.title || "No Title";
    const description = article?.description || "No Description";
    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Prompt asking for component scores
    return `Analyze the article (Title: "${title}", Desc: "${description}") on ${currentDate}. Base analysis *only* on provided text. Return ONLY a valid JSON object.

INSTRUCTIONS:
1. 'analysisType': 'Full' (news) or 'SentimentOnly' (review/opinion).
2. 'sentiment': 'Positive', 'Negative', 'Neutral'.
3. 'politicalLean': 'Left'/'Left-Leaning'/'Center'/'Right-Leaning'/'Right'/'Not Applicable'.
4. If 'Full', estimate ALL component scores (0-100).
5. If 'SentimentOnly', set ALL component scores below strictly to 0.

JSON Structure (Return ONLY this object):
{
  "summary": "Neutral summary (exactly 60 words).",
  "category": "Politics/Economy/Technology/Health/Environment/Justice/Education/Entertainment/Sports/Other",
  "politicalLean": "Center",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "estimated_components": {
    "credibility": {
      "SC_Historical_Accuracy": 75, "SC_Org_Reputation": 70, "SC_Industry_Recognition": 60, "SC_Corrections_Policy_Quality": 65, "SC_Editorial_Standards": 70,
      "VC_Source_Citation_Quality": 70, "VC_Fact_Verification_Process": 65, "VC_Claims_Substantiation": 70, "VC_External_Validation": 60,
      "PC_Objectivity_Score": 70, "PC_Source_Transparency": 75, "PC_Editorial_Independence": 70, "PC_Professional_Standards_Adherence": 70,
      "EC_Data_Quality": 65, "EC_Evidence_Strength": 70, "EC_Expert_Validation": 60, "EC_Methodological_Rigor": 50,
      "TC_Source_Disclosure": 75, "TC_Ownership_Transparency": 50, "TC_Corrections_Transparency": 60, "TC_Financial_Transparency": 40,
      "AC_Reader_Trust_Rating": 60, "AC_Community_Fact_Check_Score": 50, "AC_Cross_Platform_Reputation": 60
    },
    "reliability": {
      "CM_Accuracy_Consistency": 70, "CM_Quality_Variance": 75, "CM_Bias_Stability": 70, "CM_Source_Pattern_Consistency": 70,
      "TS_Historical_Track_Record": 60, "TS_Publication_Longevity": 60, "TS_Performance_Trend": 50,
      "QC_Editorial_Review_Process": 70, "QC_Fact_Checking_Infrastructure": 65, "QC_Error_Detection_Rate": 60, "QC_Correction_Response_Time": 60,
      "PS_Journalistic_Code_Adherence": 70, "PS_Industry_Certification": 40, "PS_Professional_Membership": 50, "PS_Ethics_Compliance": 70,
      "RCS_Correction_Rate_Quality": 80, "RCS_Retraction_Appropriateness": 70, "RCS_Accountability_Transparency": 65,
      "UMS_Story_Update_Frequency": 60, "UMS_Update_Substantiveness": 70, "UMS_Archive_Accuracy": 75
    },
    "bias": {
      "L_Linguistic_Bias": 50, "S_Source_Bias": 50, "P_Psychological_Bias": 50, "C_Content_Bias": 50, "T_Temporal_Bias": 50,
      "M_Meta_Info_Bias": 50, "D_Demographic_Bias": 50, "ST_Structural_Bias": 50, "CU_Cultural_Bias": 50, "EC_Economic_Bias": 50, "EN_Environmental_Bias": 50
    }
  },
  "keyFindings": ["Finding 1 based *only* on article.", "Finding 2 based *only* on article."],
  "recommendations": ["Recommendation 1 based on analysis.", "Recommendation 2 based on analysis."]
}`;
  }


  // --- Parse and Validate Response ---
  parseAnalysisResponse(data) {
    try {
        // 1. Check Safety Blocks / API Errors
        if (!data.candidates || data.candidates.length === 0) {
            const blockReason = data.promptFeedback?.blockReason || 'No candidates';
            console.error(`❌ Parser Error: Response blocked/no candidates. Reason: ${blockReason}`, data.promptFeedback?.safetyRatings);
            throw new Error(`API Response Error: ${blockReason}`);
        }
        const candidate = data.candidates[0];

        // 2. Check Candidate Finish Reason
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`⚠️ Parser Warning: Candidate finishReason: ${candidate.finishReason}. Content may be partial.`, candidate.safetyRatings);
            if (candidate.finishReason === 'SAFETY') throw new Error(`API Response Blocked: Candidate stopped for SAFETY`);
            if (!candidate.content?.parts?.[0]?.text) throw new Error(`Candidate stopped for ${candidate.finishReason} and has no text.`);
        }

        // 3. Safely Extract Text
        const text = candidate.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Response candidate missing valid text content');

        // 4. Extract JSON Object (Handles potential markdown)
        const jsonMatch = text.trim().match(/(?:```json)?\s*(\{[\s\S]*\})\s*(?:```)?/);
        if (!jsonMatch?.[1]) { // Check capture group 1 exists
           console.error("❌ Parser Error: Could not extract valid JSON object from text:", text.substring(0, 500) + '...');
           throw new Error('No valid JSON object found in response text');
        }
        const jsonString = jsonMatch[1];

        // 5. Parse JSON
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
            if (typeof parsed !== 'object' || parsed === null) throw new Error('Parsed content is not a valid object');
        } catch (parseError) {
            console.error("❌ Parser Error: Failed to parse extracted JSON string:", parseError.message);
            console.error("--- JSON String Attempted (truncated) ---");
            console.error(jsonString.substring(0, 500) + (jsonString.length > 500 ? '...' : ''));
            console.error("--- End JSON String ---");
            // Add MAX_TOKENS context if relevant
            const reason = candidate.finishReason === 'MAX_TOKENS' ? ' (MAX_TOKENS likely caused incomplete response)' : '';
            throw new Error(`Failed to parse JSON${reason}: ${parseError.message}`);
        }

        // 6. Basic Validation & Defaults
        parsed.summary = (typeof parsed.summary === 'string' && parsed.summary.trim()) ? parsed.summary.trim() : 'Summary unavailable';
        if (!parsed.estimated_components || typeof parsed.estimated_components !== 'object') {
             console.error("❌ Parser Error: Missing 'estimated_components' object."); throw new Error('Missing estimated_components');
        }
        parsed.estimated_components.credibility = typeof parsed.estimated_components.credibility === 'object' ? parsed.estimated_components.credibility : {};
        parsed.estimated_components.reliability = typeof parsed.estimated_components.reliability === 'object' ? parsed.estimated_components.reliability : {};
        parsed.estimated_components.bias = typeof parsed.estimated_components.bias === 'object' ? parsed.estimated_components.bias : {};

        parsed.category = parsed.category || 'General';
        parsed.analysisType = ['Full', 'SentimentOnly'].includes(parsed.analysisType) ? parsed.analysisType : 'Full';
        parsed.sentiment = ['Positive', 'Negative', 'Neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'Neutral';
        const defaultLean = parsed.analysisType === 'SentimentOnly' ? 'Not Applicable' : 'Center';
        parsed.politicalLean = ['Left', 'Left-Leaning', 'Center', 'Right-Leaning', 'Right', 'Not Applicable'].includes(parsed.politicalLean) ? parsed.politicalLean : defaultLean;
        parsed.keyFindings = Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [];
        parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

        return parsed; // Return object with estimates

    } catch (error) {
        console.error(`❌ Error during Gemini response parsing/validation stage: ${error.message}`);
        if (process.env.NODE_ENV !== 'production') {
             console.error("--- Raw Response Data (if available) ---");
             try { console.error(JSON.stringify(data, null, 2)); } catch { console.error("Could not stringify raw data."); }
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
        keyLast4: key ? `...${key.slice(-4)}` : 'N/A',
        usage: key ? (this.keyUsageCount.get(key) || 0) : 0,
        consecutiveErrors: key ? (this.keyErrorCount.get(key) || 0) : 0
      }))
    };
  }
}

module.exports = new GeminiService();
