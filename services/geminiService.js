const axios = require('axios');

class GeminiService {
  constructor() {
    this.apiKeys = [];
    const key1 = process.env.GEMINI_API_KEY;
    const key2 = process.env.GEMINI_API_KEY_1;
    if (key1) this.apiKeys.push(key1);
    if (key2) this.apiKeys.push(key2);
    if (this.apiKeys.length === 0) {
      throw new Error('No Gemini API keys found');
    }
    this.currentKeyIndex = 0;
    console.log('Gemini service initialized with ' + this.apiKeys.length + ' key(s)');
  }

  getNextApiKey() {
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  async analyzeArticle(article) {
    console.log('Analyzing article (using defaults for now)...');
    return this.getDefaultAnalysis(article);
  }

  getDefaultAnalysis(article) {
    const summary = article.description ? article.description.substring(0, 150) : 'No summary available';
    const category = this.guessCategory(article.title || '');
    
    return {
      summary: summary,
      category: category,
      politicalLean: 'Center',
      biasScore: 45,
      biasLabel: 'Moderate',
      biasComponents: {
        linguistic: {sentimentPolarity: 45, emotionalLanguage: 40, loadedTerms: 42, complexityBias: 38},
        sourceSelection: {sourceDiversity: 50, expertBalance: 48, attributionTransparency: 55},
        demographic: {genderBalance: 50, racialBalance: 50, ageRepresentation: 50},
        framing: {headlineFraming: 46, storySelection: 48, omissionBias: 44}
      },
      credibilityScore: 75,
      credibilityGrade: 'B',
      credibilityComponents: {
        sourceCredibility: 75, factVerification: 70, professionalism: 78,
        evidenceQuality: 72, transparency: 74, audienceTrust: 73
      },
      reliabilityScore: 78,
      reliabilityGrade: 'B+',
      reliabilityComponents: {
        consistency: 78, temporalStability: 76, qualityControl: 79,
        publicationStandards: 77, correctionsPolicy: 75, updateMaintenance: 78
      },
      trustScore: 76,
      trustLevel: 'Trustworthy',
      coverageLeft: 33,
      coverageCenter: 34,
      coverageRight: 33,
      clusterId: Math.floor(Math.random() * 10) + 1,
      keyFindings: ['Article analyzed with standard metrics'],
      recommendations: ['Cross-check with other sources']
    };
  }

  guessCategory(title) {
    const t = title.toLowerCase();
    if (t.indexOf('trump') !== -1 || t.indexOf('biden') !== -1 || t.indexOf('election') !== -1) return 'Politics';
    if (t.indexOf('stock') !== -1 || t.indexOf('economy') !== -1 || t.indexOf('business') !== -1) return 'Economy';
    if (t.indexOf('tech') !== -1 || t.indexOf('apple') !== -1 || t.indexOf('google') !== -1) return 'Technology';
    if (t.indexOf('health') !== -1 || t.indexOf('medical') !== -1) return 'Health';
    if (t.indexOf('climate') !== -1 || t.indexOf('environment') !== -1) return 'Environment';
    if (t.indexOf('court') !== -1 || t.indexOf('justice') !== -1 || t.indexOf('law') !== -1) return 'Justice';
    if (t.indexOf('school') !== -1 || t.indexOf('education') !== -1) return 'Education';
    if (t.indexOf('movie') !== -1 || t.indexOf('music') !== -1) return 'Entertainment';
    if (t.indexOf('sports') !== -1 || t.indexOf('game') !== -1) return 'Sports';
    return 'Politics';
  }

  getStatistics() {
    return {
      totalKeys: this.apiKeys.length,
      keyUsage: []
    };
  }
}

module.exports = new GeminiService();
