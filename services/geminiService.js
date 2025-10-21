// services/geminiService.js
const axios = require('axios');

class GeminiService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });
    
    console.log(`🤖 Loaded ${this.apiKeys.length} Gemini API key(s)`);
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
    if (keys.length === 0 && process.env.GEMINI_API_KEY_1) {
      keys.push(process.env.GEMINI_API_KEY_1);
    }
    if (keys.length === 0) {
      console.error('❌ No Gemini API keys found!');
      throw new Error('No Gemini API keys provided!');
    }
    return keys;
  }

  getNextApiKey() {
    if (!this.apiKeys.length) throw new Error('No Gemini API keys available');
    const maxErrors = 5;
    let checked = 0;
    
    while (checked < this.apiKeys.length) {
      const key = this.apiKeys[this.currentKeyIndex];
      const errorCount = this.keyErrorCount.get(key) || 0;
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      
      if (errorCount < maxErrors) return key;
      checked++;
    }
    
    // Reset error counts if all keys have errors
    this.apiKeys.forEach(key => this.keyErrorCount.set(key, 0));
    return this.apiKeys[0];
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
  }

  recordError(apiKey) {
    this.keyErrorCount.set(apiKey, (this.keyErrorCount.get(apiKey) || 0) + 1);
  }

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
        console.error(`Gemini attempt ${attempt + 1} failed:`, err.message);
      }
    }
    
    // Return default values if all attempts fail
    console.error('All Gemini attempts failed, returning defaults');
    return this.getDefaultAnalysis(article);
  }

  async makeAnalysisRequest(article, apiKey) {
    const prompt = this.buildEnhancedPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
    
    try {
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            topK: 32,
            topP: 0.95,
            maxOutputTokens: 2048
          }
        },
        { timeout: 30000 }
      );
      
      const result = this.parseAnalysisResponse(response.data, article);
      return result;
    } catch (err) {
      this.recordError(apiKey);
      console.error('Gemini API error:', err.response?.data || err.message);
      throw err;
    }
  }

  buildEnhancedPrompt(article) {
    return `You are an expert news analyst. Analyze this news article and return ONLY valid JSON with NO markdown formatting, NO code blocks, NO explanations.

Article Title: ${article.title}
Description: ${article.description || 'No description'}
Source: ${article.source?.name || 'Unknown'}

Return this EXACT JSON structure with realistic scores (30-80 range for most values):

{
  "summary": "A concise 50-60 word summary of the article",
  "category": "Politics",
  "politicalLean": "Center",
  "biasScore": 45,
  "biasLabel": "Moderate Bias",
  "biasComponents": {
    "linguistic": {
      "sentimentPolarity": 42,
      "emotionalLanguage": 38,
      "loadedTerms": 45,
      "complexityBias": 40
    },
    "sourceSelection": {
      "sourceDiversity": 55,
      "expertBalance": 50,
      "attributionTransparency": 60
    },
    "demographic": {
      "genderBalance": 50,
      "racialBalance": 50,
      "ageRepresentation": 50
    },
    "framing": {
      "headlineFraming": 48,
      "storySelection": 52,
      "omissionBias": 45
    }
  },
  "credibilityScore": 75,
  "credibilityGrade": "B+",
  "credibilityComponents": {
    "sourceCredibility": 78,
    "factVerification": 72,
    "professionalism": 75,
    "evidenceQuality": 70,
    "transparency": 76,
    "audienceTrust": 74
  },
  "reliabilityScore": 80,
  "reliabilityGrade": "A-",
  "reliabilityComponents": {
    "consistency": 82,
    "temporalStability": 78,
    "qualityControl": 80,
    "publicationStandards": 79,
    "correctionsPolicy": 77,
    "updateMaintenance": 81
  },
  "trustScore": 77,
  "trustLevel": "High Trustworthiness",
  "coverageLeft": 30,
  "coverageCenter": 40,
  "coverageRight": 30,
  "clusterId": ${Math.floor(Math.random() * 10) + 1},
  "keyFindings": [
    "First key finding about the article",
    "Second important insight",
    "Third notable observation"
  ],
  "recommendations": [
    "Cross-reference with other sources for complete context",
    "Verify specific claims with fact-checking services"
  ]
}

CRITICAL: Return ONLY the JSON object. NO markdown, NO \`\`\`json tags, NO explanations. Just pure JSON.`;
  }

  parseAnalysisResponse(data, article) {
    try {
      if (!data || !data.candidates || !data.candidates[0]) {
        console.error('Invalid Gemini response structure');
        return this.getDefaultAnalysis(article);
      }

      let text = data.candidates[0].content.parts[0].text;
      
      // Clean up response
      text = text.trim();
      text = text.replace(/```
      text = text.replace(/```\n?/g, '');
      text = text.replace(/^[^{]*/, ''); // Remove everything before first {
      text = text.replace(/[^}]*$/, ''); // Remove everything after last }
      
      // Find JSON object
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('No JSON found in Gemini response');
        return this.getDefaultAnalysis(article);
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate required fields
      if (!parsed.summary || !parsed.biasScore || !parsed.credibilityScore) {
        console.error('Missing required fields in analysis');
        return this.getDefaultAnalysis(article);
      }
      
      // Ensure all scores are numbers
      parsed.biasScore = Number(parsed.biasScore) || 45;
      parsed.credibilityScore = Number(parsed.credibilityScore) || 75;
      parsed.reliabilityScore = Number(parsed.reliabilityScore) || 80;
      parsed.trustScore = Number(parsed.trustScore) || Math.round(Math.sqrt(parsed.credibilityScore * parsed.reliabilityScore));
      
      // Ensure components exist with defaults
      parsed.biasComponents = parsed.biasComponents || this.getDefaultBiasComponents();
      parsed.credibilityComponents = parsed.credibilityComponents || this.getDefaultCredibilityComponents();
      parsed.reliabilityComponents = parsed.reliabilityComponents || this.getDefaultReliabilityComponents();
      
      parsed.keyFindings = parsed.keyFindings || ['Analysis completed', 'Review recommended'];
      parsed.recommendations = parsed.recommendations || ['Cross-check with other sources'];
      
      console.log(`✅ Successfully analyzed article: ${parsed.biasScore} bias, ${parsed.trustScore} trust`);
      
      return parsed;
    } catch (err) {
      console.error('Error parsing Gemini response:', err.message);
      return this.getDefaultAnalysis(article);
    }
  }

  getDefaultAnalysis(article) {
    const clusterId = Math.floor(Math.random() * 10) + 1;
    
    return {
      summary: (article.description || article.title || 'No summary available').substring(0, 200),
      category: this.guessCategory(article.title || ''),
      politicalLean: 'Center',
      
      biasScore: 45,
      biasLabel: 'Moderate Bias',
      biasComponents: this.getDefaultBiasComponents(),
      
      credibilityScore: 75,
      credibilityGrade: 'B',
      credibilityComponents: this.getDefaultCredibilityComponents(),
      
      reliabilityScore: 78,
      reliabilityGrade: 'B+',
      reliabilityComponents: this.getDefaultReliabilityComponents(),
      
      trustScore: 76,
      trustLevel: 'Trustworthy',
      
      coverageLeft: 33,
      coverageCenter: 34,
      coverageRight: 33,
      clusterId: clusterId,
      
      keyFindings: [
        'Article analyzed with default metrics',
        'Manual verification recommended',
        'Cross-reference with multiple sources'
      ],
      recommendations: [
        'Verify key claims independently',
        'Check original source for full context',
        'Compare with other news outlets'
      ]
    };
  }

  getDefaultBiasComponents() {
    return {
      linguistic: {
        sentimentPolarity: 45,
        emotionalLanguage: 40,
        loadedTerms: 42,
        complexityBias: 38
      },
      sourceSelection: {
        sourceDiversity: 50,
        expertBalance: 48,
        attributionTransparency: 55
      },
      demographic: {
        genderBalance: 50,
        racialBalance: 50,
        ageRepresentation: 50
      },
      framing: {
        headlineFraming: 46,
        storySelection: 48,
        omissionBias: 44
      }
    };
  }

  getDefaultCredibilityComponents() {
    return {
      sourceCredibility: 75,
      factVerification: 70,
      professionalism: 78,
      evidenceQuality: 72,
      transparency: 74,
      audienceTrust: 73
    };
  }

  getDefaultReliabilityComponents() {
    return {
      consistency: 78,
      temporalStability: 76,
      qualityControl: 79,
      publicationStandards: 77,
      correctionsPolicy: 75,
      updateMaintenance: 78
    };
  }

  guessCategory(title) {
    const titleLower = title.toLowerCase();
    
    // FIXED: Using includes() instead of match() to avoid regex issues
    if (titleLower.includes('trump') || titleLower.includes('biden') || 
        titleLower.includes('election') || titleLower.includes('congress') || 
        titleLower.includes('senate') || titleLower.includes('vote') || 
        titleLower.includes('campaign')) return 'Politics';
        
    if (titleLower.includes('stock') || titleLower.includes('economy') || 
        titleLower.includes('market') || titleLower.includes('trade') || 
        titleLower.includes('business') || titleLower.includes('company')) return 'Economy';
        
    if (titleLower.includes('tech') || titleLower.includes('apple') || 
        titleLower.includes('google') || titleLower.includes('ai') || 
        titleLower.includes('software') || titleLower.includes('cyber')) return 'Technology';
        
    if (titleLower.includes('health') || titleLower.includes('medical') || 
        titleLower.includes('hospital') || titleLower.includes('doctor') || 
        titleLower.includes('disease')) return 'Health';
        
    if (titleLower.includes('climate') || titleLower.includes('environment') || 
        titleLower.includes('energy') || titleLower.includes('pollution')) return 'Environment';
        
    if (titleLower.includes('court') || titleLower.includes('justice') || 
        titleLower.includes('law') || titleLower.includes('legal') || 
        titleLower.includes('crime')) return 'Justice';
        
    if (titleLower.includes('school') || titleLower.includes('education') || 
        titleLower.includes('university') || titleLower.includes('student')) return 'Education';
        
    if (titleLower.includes('movie') || titleLower.includes('music') || 
        titleLower.includes('celebrity') || titleLower.includes('entertainment')) return 'Entertainment';
        
    if (titleLower.includes('sports') || titleLower.includes('game') || 
        titleLower.includes('team') || titleLower.includes('player') || 
        titleLower.includes('nfl') || titleLower.includes('nba')) return 'Sports';
        
    return 'Politics';
  }

  getStatistics() {
    return {
      totalKeys: this.apiKeys.length,
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: key.substring(0, 10) + '...',
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    };
  }
}

module.exports = new GeminiService();
