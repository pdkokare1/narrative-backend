// services/geminiService.js (FINAL v2.6 - Formula Input Focused)
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
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} increased to ${currentErrors}`);
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
        // Pass article and key to makeAnalysisRequest
        const result = await this.makeAnalysisRequest(article, apiKeyUsed);
        this.recordSuccess(apiKeyUsed);
        return result; // Success!

      } catch (error) {
        lastError = error;
        if (apiKeyUsed) this.recordError(apiKeyUsed);

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
    } // End loop

    // If loop finishes, throw the last error, adding context
    const finalErrorMessage = `Gemini analysis failed after ${maxRetries} attempts for article "${article?.title?.substring(0, 60)}...": ${lastError?.message || 'Unknown error'}`;
    throw new Error(finalErrorMessage);
  }

  // --- Make Single API Request ---
  async makeAnalysisRequest(article, apiKey) {
    if (!apiKey) throw new Error("Internal error: apiKey missing for makeAnalysisRequest");

    // Generate the new prompt asking for component scores
    const prompt = this.buildEnhancedPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;

    try {
      // console.log("--- Sending Prompt to Gemini ---"); // Debugging
      // console.log(prompt);
      // console.log("-------------------------------");
      const response = await axios.post(
        url,
        { // Request Body
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4, // Keep temperature relatively low for consistency
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 4096 // Increased limit
          },
          safetySettings: [ // Keep safety settings relaxed
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        },
        { // Axios Config
            timeout: 75000, // Increased timeout further to 75 seconds for complex prompts
            responseType: 'json',
            validateStatus: (status) => status >= 200 && status < 300,
        }
      );

      if (!response.data || typeof response.data !== 'object') {
          throw new Error("Received invalid response data from Gemini API despite 2xx status.");
      }
      // console.log("--- Received Response from Gemini ---"); // Debugging
      // console.log(JSON.stringify(response.data, null, 2));
      // console.log("-----------------------------------");
      return this.parseAnalysisResponse(response.data); // Parse the component scores

    } catch (error) {
        // Handle Axios errors (same logic as before)
        if (error.response) {
            console.error(`❌ Gemini API HTTP Error: Status ${error.response.status}`, error.response.data);
            if (error.response.status === 503 || error.response.status === 429) {
                error.message = `Gemini API returned status ${error.response.status}`;
                throw error; // Let analyzeArticle handle retry
            }
            throw new Error(`Gemini API request failed with HTTP status ${error.response.status}`);
        } else if (error.request) {
            console.error('❌ Gemini API Network Error: No response.', error.message);
            throw new Error(`Gemini API request failed: No response (check network/timeout).`);
        } else {
            console.error('❌ Gemini API Setup Error:', error.message);
            throw new Error(`Gemini API request setup failed: ${error.message}`);
        }
    }
  }

  // --- NEW Prompt to get Component Scores ---
  buildEnhancedPrompt(article) {
    const title = article?.title || "No Title";
    const description = article?.description || "No Description";
    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // NOTE: This prompt asks for many individual scores based on the PDF definitions.
    // It's crucial that Gemini understands and provides these reliably.
    // The scale is assumed to be 0-100 unless specified otherwise.
    return `You are an expert news analyst evaluating an article on ${currentDate}.
Analyze the article (Title: "${title}", Description: "${description}") based *solely* on the provided text.
Return ONLY a single, valid JSON object containing estimates for the following metrics. Do NOT calculate final scores (like UCS, URS, Bias Score, Trust Score).

INSTRUCTIONS:
1.  Determine 'analysisType' ('Full' or 'SentimentOnly') and 'sentiment' ('Positive', 'Negative', 'Neutral').
2.  Estimate 'politicalLean' ('Left', 'Left-Leaning', 'Center', 'Right-Leaning', 'Right', 'Not Applicable') based SOLELY on this article's content.
3.  For 'Full' analysisType, estimate all component scores below (0-100 scale).
4.  For 'SentimentOnly', set ALL component scores below strictly to 0.

Return ONLY this exact JSON structure with your estimated values:

{
  "summary": "Neutral summary (exactly 60 words) based *only* on the provided text.",
  "category": "One category: Politics/Economy/Technology/Health/Environment/Justice/Education/Entertainment/Sports/Other",
  "politicalLean": "Center",
  "analysisType": "Full",
  "sentiment": "Neutral",

  "estimated_components": {
    "credibility": {
      "SC_Historical_Accuracy": 75, // Source Credibility: Based on perceived track record if inferrable, else estimate average (e.g., 70-80 for known sources)
      "SC_Org_Reputation": 70, // Source Credibility: Estimate based on source name (80-100 major, 60-80 regional, 40-60 emerging, 20-40 unknown)
      "SC_Industry_Recognition": 60, // Source Credibility: Awards, standing (Lower default if unknown)
      "SC_Corrections_Policy_Quality": 65, // Source Credibility: Assume basic policy unless stated otherwise
      "SC_Editorial_Standards": 70, // Source Credibility: Assume standard process unless clear red flags

      "VC_Source_Citation_Quality": 70, // Verification: Quality/presence of cited sources in text
      "VC_Fact_Verification_Process": 65, // Verification: Evidence of multi-sourcing or expert use in text
      "VC_Claims_Substantiation": 70, // Verification: Strength of evidence presented for claims
      "VC_External_Validation": 60, // Verification: Mentions of external checks (assume low if none mentioned)

      "PC_Objectivity_Score": 70, // Professionalism: Balanced tone, neutral language
      "PC_Source_Transparency": 75, // Professionalism: Author attribution, source disclosure mentioned
      "PC_Editorial_Independence": 70, // Professionalism: Assumed unless clear influence stated/implied
      "PC_Professional_Standards_Adherence": 70, // Professionalism: General journalistic standards adherence

      "EC_Data_Quality": 65, // Evidence Quality: Reliability/transparency of data cited (if any)
      "EC_Evidence_Strength": 70, // Evidence Quality: Type of evidence used (primary, secondary, expert)
      "EC_Expert_Validation": 60, // Evidence Quality: Use of named experts/academic sources
      "EC_Methodological_Rigor": 50, // Evidence Quality: Mention of research methods (assume low if none)

      "TC_Source_Disclosure": 75, // Transparency: How clearly are sources named/linked
      "TC_Ownership_Transparency": 50, // Transparency: Assume opaque unless source is known non-profit/public
      "TC_Corrections_Transparency": 60, // Transparency: Assume basic unless corrections are prominent
      "TC_Financial_Transparency": 40, // Transparency: Assume low unless funding is disclosed

      "AC_Reader_Trust_Rating": 60, // Audience Trust: General estimate based on perceived source type (cannot measure directly)
      "AC_Community_Fact_Check_Score": 50, // Audience Trust: Assume neutral unless widely debated topic
      "AC_Cross_Platform_Reputation": 60 // Audience Trust: General estimate based on source name (cannot measure directly)
    },
    "reliability": {
      "CM_Accuracy_Consistency": 70, // Consistency: Assume moderate consistency unless source known for issues
      "CM_Quality_Variance": 75, // Consistency: Assume relatively low variance (higher score) unless erratic source
      "CM_Bias_Stability": 70, // Consistency: Assume stable bias unless source known for shifts
      "CM_Source_Pattern_Consistency": 70, // Consistency: Assume consistent sourcing patterns

      "TS_Historical_Track_Record": 60, // Temporal Stability: Estimate based on source name/age if known (lower default)
      "TS_Publication_Longevity": 60, // Temporal Stability: Related to track record
      "TS_Performance_Trend": 50, // Temporal Stability: Assume stable trend (neutral score)

      "QC_Editorial_Review_Process": 70, // Quality Control: Assume standard review unless stated otherwise
      "QC_Fact_Checking_Infrastructure": 65, // Quality Control: Assume basic checks unless dedicated team mentioned
      "QC_Error_Detection_Rate": 60, // Quality Control: Estimate internal error catching ability (difficult to know)
      "QC_Correction_Response_Time": 60, // Quality Control: Assume moderate response time

      "PS_Journalistic_Code_Adherence": 70, // Publication Standards: Assume general adherence
      "PS_Industry_Certification": 40, // Publication Standards: Assume none unless source known for it
      "PS_Professional_Membership": 50, // Publication Standards: Assume some basic membership
      "PS_Ethics_Compliance": 70, // Publication Standards: Assume compliant unless major scandals known

      "RCS_Correction_Rate_Quality": 80, // Retraction/Correction: Lower score = higher correction rate (assume low rate = 80+)
      "RCS_Retraction_Appropriateness": 70, // Retraction/Correction: Assume retractions are appropriate
      "RCS_Accountability_Transparency": 65, // Retraction/Correction: Visibility/explanation of corrections

      "UMS_Story_Update_Frequency": 60, // Update Maintenance: Frequency of updates on developing stories (guess based on topic)
      "UMS_Update_Substantiveness": 70, // Update Maintenance: Quality of updates
      "UMS_Archive_Accuracy": 75 // Update Maintenance: Assume archives are accurate with markers
    },
    "bias": {
      // Using E-UBDF component names where possible, estimate 0-100
      "L_Linguistic_Bias": 50, // Overall linguistic bias estimate
      "S_Source_Bias": 50, // Overall source selection bias estimate
      "P_Psychological_Bias": 50, // Framing, cognitive effects estimate
      "C_Content_Bias": 50, // Omission, selection bias estimate
      "T_Temporal_Bias": 50, // Focus on recent vs historical context inappropriately
      "M_Meta_Info_Bias": 50, // Bias from headlines, images, captions
      "D_Demographic_Bias": 50, // Representation bias (gender, race etc.)
      "ST_Structural_Bias": 50, // Bias from ownership, commercial interests (estimate based on source type)
      "CU_Cultural_Bias": 50, // Geographic, cultural imperialism estimate
      "EC_Economic_Bias": 50, // Bias related to financial reporting or influence
      "EN_Environmental_Bias": 50 // Bias in reporting environmental issues
    }
  },

  "keyFindings": ["Finding 1 based *only* on article.", "Finding 2 based *only* on article."],
  "recommendations": ["Recommendation 1 based on analysis.", "Recommendation 2 based on analysis."]
}

IMPORTANT: Provide estimates (0-100) for ALL components listed in 'estimated_components'. If 'analysisType' is 'SentimentOnly', ALL component scores MUST be 0. Output ONLY the JSON object.`;
  }

  // --- Parse and Validate the Gemini JSON Response (expects component scores) ---
  parseAnalysisResponse(data) {
    try {
        // 1. Check Safety Blocks / API Errors
        if (!data.candidates || data.candidates.length === 0) {
            const blockReason = data.promptFeedback?.blockReason || 'No candidates in response';
            console.error(`❌ Parser Error: Response blocked/no candidates. Reason: ${blockReason}`, data.promptFeedback?.safetyRatings);
            throw new Error(`API Response Error: ${blockReason}`);
        }
        const candidate = data.candidates[0];

        // 2. Check Candidate Finish Reason (treat non-STOP as potential issue)
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`⚠️ Parser Warning: Candidate finishReason: ${candidate.finishReason}. Content may be partial/missing.`, candidate.safetyRatings);
            if (candidate.finishReason === 'SAFETY') throw new Error(`API Response Blocked: Candidate stopped for SAFETY`);
            // Allow MAX_TOKENS etc., but check content exists
            if (!candidate.content?.parts?.[0]?.text) throw new Error(`Candidate stopped for ${candidate.finishReason} and has no text.`);
        }

        // 3. Safely Extract Text
        const text = candidate.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('Response candidate missing valid text content');

        // 4. Extract JSON Object (Handles potential markdown)
        const jsonMatch = text.trim().match(/(?:```json)?\s*(\{[\s\S]*\})\s*(?:```)?/);
        if (!jsonMatch?.[1]) throw new Error('No valid JSON object found in response text');
        const jsonString = jsonMatch[1];

        // 5. Parse the Extracted JSON
        let parsed;
        try {
            parsed = JSON.parse(jsonString);
            if (typeof parsed !== 'object' || parsed === null) throw new Error('Parsed content is not a valid object');
        } catch (parseError) {
            console.error("❌ Parser Error: Failed to parse extracted JSON string:", parseError.message);
            console.error("--- JSON String Attempted ---");
            console.error(jsonString);
            console.error("--- End JSON String ---");
            throw new Error(`Failed to parse JSON: ${parseError.message}`);
        }

        // 6. Basic Validation & Return Structure (Return components for calculation)
        // Ensure the main structure and estimated_components exist
        if (!parsed.summary || typeof parsed.summary !== 'string') throw new Error('Missing or invalid summary');
        if (!parsed.estimated_components || typeof parsed.estimated_components !== 'object') throw new Error('Missing estimated_components object');
        if (!parsed.estimated_components.credibility || !parsed.estimated_components.reliability || !parsed.estimated_components.bias) throw new Error('Missing credibility, reliability, or bias components');

        // Return the parsed object containing the estimated components
        // The calling function (in server.js) will now perform calculations.
        // We can add basic validation for types/ranges here if desired, but keep it simpler for now.
        // Example basic check:
        if (typeof parsed.estimated_components.credibility.SC_Historical_Accuracy !== 'number') {
            console.warn("Warning: SC_Historical_Accuracy is not a number, defaulting might occur.");
            // Or throw new Error('Invalid type for SC_Historical_Accuracy');
        }

        // Add defaults for top-level qualitative fields if missing
        parsed.category = parsed.category || 'General';
        parsed.politicalLean = parsed.politicalLean || 'Center';
        parsed.analysisType = parsed.analysisType || 'Full';
        parsed.sentiment = parsed.sentiment || 'Neutral';
        parsed.keyFindings = Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [];
        parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];


        return parsed; // Return the object with estimated components

    } catch (error) {
        console.error(`❌ Error during Gemini response parsing/validation: ${error.message}`);
        if (process.env.NODE_ENV !== 'production') {
             console.error("--- Raw Response Data ---");
             console.error(JSON.stringify(data, null, 2));
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
