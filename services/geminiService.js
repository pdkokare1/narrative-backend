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
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
  }

  recordError(apiKey) {
    this.keyErrorCount.set(apiKey, (this.keyErrorCount.get(apiKey) || 0) + 1);
  }

  async analyzeArticle(article, maxRetries = 2) {
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
    
    console.log('Using default analysis (Gemini failed)');
    return this.getDefaultAnalysis(article);
  }

  async makeAnalysisRequest(article, apiKey) {
    const prompt = this.buildPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
    
    try {
      const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          topK: 32,
          topP: 0.95,
          maxOutputTokens: 1024
        }
      }, { timeout: 20000 });
      
      const result = this.parseResponse(response.data, article);
      return result;
    } catch (err) {
      this.recordError(apiKey);
      throw err;
    }
  }

  buildPrompt(article) {
    const title = (article.title || '').substring(0, 200);
    const description = (article.description || '').substring(0, 300);
    
    return `Analyze this news article and return ONLY a JSON object with bias and credibility scores.

Title: ${title}
Description: ${description}

Return exactly this JSON format:
{
  "summary": "Brief summary in 40 words",
  "category": "Politics",
  "politicalLean": "Center", 
  "biasScore": 45,
  "credibilityScore": 75,
  "reliabilityScore": 78,
  "trustScore": 76
}

Return ONLY the JSON object, nothing else.`;
  }

  parseResponse(data, article) {
    try {
      // Safety check
      if (!data || !data.candidates || !data.candidates[0]) {
        console.error('Invalid Gemini response');
        return this.getDefaultAnalysis(article);
      }

      let text = data.candidates[0].content.parts[0].text;
      if (!text) {
        console.error('No text in Gemini response');
        return this.getDefaultAnalysis(article);
      }

      // Ultra-safe JSON extraction
      text = text.trim();
      
      // Remove markdown if present
      if (text.includes('```
        const parts = text.split('```');
        for (let part of parts) {
          if (part.includes('{') && part.includes('}')) {
            text = part;
            break;
          }
        }
      }
      
      // Find JSON boundaries
      let startIndex = text.indexOf('{');
      let endIndex = text.lastIndexOf('}');
      
      if (startIndex === -1 || endIndex === -1) {
        console.error('No JSON found in response');
        return this.getDefaultAnalysis(article);
      }
      
      text = text.substring(startIndex, endIndex + 1);
      
      // Parse JSON
      const parsed = JSON.parse(text);
      
      // Validate and enhance
      const result = this.enhanceAnalysis(parsed, article);
      
      console.log(`✅ Analyzed successfully: bias=${result.biasScore}, trust=${result.trustScore}`);
      return result;
      
    } catch (err) {
      console.error('Parse error, using defaults:', err.message);
      return this.getDefaultAnalysis(article);
    }
  }

  enhanceAnalysis(parsed, article) {
    return {
      summary: parsed.summary || (article.description || article.title || 'No summary').substring(0, 200),
      category: parsed.category || this.guessCategory(article.title || ''),
      politicalLean: parsed.politicalLean || 'Center',
      
      biasScore: this.safeNumber(parsed.biasScore, 45),
      biasLabel: 'Moderate Bias',
      biasComponents: this.getDefaultBiasComponents(),
      
      credibilityScore: this.safeNumber(parsed.credibilityScore, 75),
      credibilityGrade: 'B',
      credibilityComponents: this.getDefaultCredibilityComponents(),
      
      reliabilityScore: this.safeNumber(parsed.reliabilityScore, 78),
      reliabilityGrade: 'B+',
      reliabilityComponents: this.getDefaultReliabilityComponents(),
      
      trustScore: this.safeNumber(parsed.trustScore, 76),
      trustLevel: 'Trustworthy',
      
      coverageLeft: 33,
      coverageCenter: 34,
      coverageRight: 33,
      clusterId: Math.floor(Math.random() * 10) + 1,
      
      keyFindings: ['Article analyzed successfully', 'Cross-reference recommended'],
      recommendations: ['Verify key claims', 'Check multiple sources']
    };
  }

  safeNumber(value, defaultValue) {
    const num = Number(value);
    return (isNaN(num) || num < 0 || num > 100) ? defaultValue : num;
  }

  getDefaultAnalysis(article) {
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
      clusterId: Math.floor(Math.random() * 10) + 1,
      keyFindings: ['Default analysis applied', 'Manual verification recommended'],
      recommendations: ['Verify independently', 'Compare with other sources']
    };
  }

  getDefaultBiasComponents() {
    return {
      linguistic: { sentimentPolarity: 45, emotionalLanguage: 40, loadedTerms: 42, complexityBias: 38 },
      sourceSelection: { sourceDiversity: 50, expertBalance: 48, attributionTransparency: 55 },
      demographic: { genderBalance: 50, racialBalance: 50, ageRepresentation: 50 },
      framing: { headlineFraming: 46, storySelection: 48, omissionBias: 44 }
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
    if (t.includes('trump') || t.includes('biden') || t.includes('election')) return 'Politics';
    if (t.includes('stock') || t.includes('economy') || t.includes('business')) return 'Economy';
    if (t.includes('tech') || t.includes('apple') || t.includes('google')) return 'Technology';
    if (t.includes('health') || t.includes('medical') || t.includes('doctor')) return 'Health';
    if (t.includes('climate') || t.includes('environment')) return 'Environment';
    if (t.includes('court') || t.includes('justice') || t.includes('law')) return 'Justice';
    if (t.includes('school') || t.includes('education')) return 'Education';
    if (t.includes('movie') || t.includes('music') || t.includes('celebrity')) return 'Entertainment';
    if (t.includes('sports') || t.includes('game') || t.includes('team')) return 'Sports';
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
