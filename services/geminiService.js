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
    const safeTitle = (article.title || 'No title').replace(/"/g, "'");
    const safeDesc = (article.description || 'No description').replace(/"/g, "'");
    const safeSource = (article.source?.name || 'Unknown').replace(/"/g, "'");
    
    return `You are an expert news analyst. Analyze this news article and return ONLY valid JSON with NO markdown formatting, NO code blocks, NO explanations.

Article Title: ${safeTitle}
Description: ${safeDesc}
Source: ${safeSource}

Return this EXACT JSON structure with realistic scores (30-80 range):

{
  "summary": "A concise 50-60 word summary of the article",
  "category": "Politics",
  "politicalLean": "Center",
  "biasScore": 45,
  "biasLabel": "Moderate Bias",
  "biasComponents": {
    "linguistic": {"sentimentPolarity": 42, "emotionalLanguage": 38, "loadedTerms": 45, "complexityBias": 40},
    "sourceSelection": {"sourceDiversity": 55, "expertBalance": 50, "attributionTransparency": 60},
    "demographic": {"genderBalance": 50, "racialBalance": 50, "ageRepresentation": 50},
    "framing": {"headlineFraming": 48, "storySelection": 52, "omissionBias": 45}
  },
  "credibilityScore": 75,
  "credibilityGrade": "B+",
  "credibilityComponents": {"sourceCredibility": 78, "factVerification": 72, "professionalism": 75, "evidenceQuality": 70, "transparency": 76, "audienceTrust": 74},
  "reliabilityScore": 80,
  "reliabilityGrade": "A-",
  "reliabilityComponents": {"consistency": 82, "temporalStability": 78, "qualityControl": 80, "publicationStandards": 79, "correctionsPolicy": 77, "updateMaintenance": 81},
  "trustScore": 77,
  "trustLevel": "High Trustworthiness",
  "coverageLeft": 30,
  "coverageCenter": 40,
  "coverageRight": 30,
  "clusterId": ${Math.floor(Math.random() * 10) + 1},
  "keyFindings": ["First key finding", "Second insight", "Third observation"],
  "recommendations": ["Cross-reference with other sources", "Verify specific claims"]
}

CRITICAL: Return ONLY the JSON object. NO markdown, NO backticks, NO explanations.`;
  }

  parseAnalysisResponse(data, article) {
    try {
      if (!data || !data.candidates || !data.candidates[0]) {
        console.error('Invalid Gemini response structure');
        return this.getDefaultAnalysis(article);
      }

      let text = data.candidates[0].content.parts[0].text.trim();
      
      // Remove markdown code blocks without regex
      if (text.startsWith('```
        text = text.substring(7);
      }
      if (text.startsWith('```')) {
        text = text.substring(3);
      }
      if (text.endsWith('```
        text = text.substring(0, text.length - 3);
      }
      text = text.trim();
      
      // Find JSON object boundaries
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      
      if (firstBrace === -1 || lastBrace === -1) {
        console.error('No JSON found in response');
        return this.getDefaultAnalysis(article);
      }
      
      text = text.substring(firstBrace, lastBrace + 1);
      
      const parsed = JSON.parse(text);
      
      if (!parsed.summary || !parsed.biasScore || !parsed.credibilityScore) {
        console.error('Missing required fields');
        return this.getDefaultAnalysis(article);
      }
      
      parsed.biasScore = Number(parsed.biasScore) || 45;
      parsed.credibilityScore = Number(parsed.credibilityScore) || 75;
      parsed.reliabilityScore = Number(parsed.reliabilityScore) || 80;
      parsed.trustScore = Number(parsed.trustScore) || 76;
      
      parsed.biasComponents = parsed.biasComponents || this.getDefaultBiasComponents();
      parsed.credibilityComponents = parsed.credibilityComponents || this.getDefaultCredibilityComponents();
      parsed.reliabilityComponents = parsed.reliabilityComponents || this.getDefaultReliabilityComponents();
      
      parsed.keyFindings = parsed.keyFindings || ['Analysis completed'];
      parsed.recommendations = parsed.recommendations || ['Cross-check with other sources'];
      
      console.log(`✅ Analyzed: bias=${parsed.biasScore}, trust=${parsed.trustScore}`);
      
      return parsed;
    } catch (err) {
      console.error('Parse error:', err.message);
      return this.getDefaultAnalysis(article);
    }
  }

  getDefaultAnalysis(article) {
    return {
      summary: (article.description || article.title || 'No summary').substring(0, 200),
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
      clusterId: Math.floor(Math.random() * 10) + 1,
      keyFindings: ['Article analyzed with default metrics', 'Manual verification recommended'],
      recommendations: ['Verify key claims independently', 'Compare with other outlets']
    };
  }

  getDefaultBiasComponents() {
    return {
      linguistic: {sentimentPolarity: 45, emotionalLanguage: 40, loadedTerms: 42, complexityBias: 38},
      sourceSelection: {sourceDiversity: 50, expertBalance: 48, attributionTransparency: 55},
      demographic: {genderBalance: 50, racialBalance: 50, ageRepresentation: 50},
      framing: {headlineFraming: 46, storySelection: 48, omissionBias: 44}
    };
  }

  getDefaultCredibilityComponents() {
    return {
      sourceCredibility: 75, factVerification: 70, professionalism: 78,
      evidenceQuality: 72, transparency: 74, audienceTrust: 73
    };
  }

  getDefaultReliabilityComponents() {
    return {
      consistency: 78, temporalStability: 76, qualityControl: 79,
      publicationStandards: 77, correctionsPolicy: 75, updateMaintenance: 78
    };
  }

  guessCategory(title) {
    const t = title.toLowerCase();
    if (t.includes('trump') || t.includes('biden') || t.includes('election') || t.includes('congress')) return 'Politics';
    if (t.includes('stock') || t.includes('economy') || t.includes('market') || t.includes('business')) return 'Economy';
    if (t.includes('tech') || t.includes('apple') || t.includes('google') || t.includes('ai')) return 'Technology';
    if (t.includes('health') || t.includes('medical') || t.includes('doctor') || t.includes('hospital')) return 'Health';
    if (t.includes('climate') || t.includes('environment') || t.includes('energy')) return 'Environment';
    if (t.includes('court') || t.includes('justice') || t.includes('law') || t.includes('crime')) return 'Justice';
    if (t.includes('school') || t.includes('education') || t.includes('university')) return 'Education';
    if (t.includes('movie') || t.includes('music') || t.includes('celebrity')) return 'Entertainment';
    if (t.includes('sports') || t.includes('game') || t.includes('team') || t.includes('nfl')) return 'Sports';
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
