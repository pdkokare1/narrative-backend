const axios = require('axios');

class NewsService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();
    this.maxConsecutiveErrors = 3;

    this.apiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });

    console.log(`📰 Loaded ${this.apiKeys.length} NewsAPI key(s)`);
  }

  loadApiKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`NEWS_API_KEY_${i}`];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.NEWS_API_KEY) {
      keys.push(process.env.NEWS_API_KEY);
    }
    if (keys.length === 0) {
      throw new Error('No NewsAPI keys found!');
    }
    return keys;
  }

  getRotationalApiKey() {
    let cycles = 0;
    while (cycles < this.apiKeys.length) {
      const key = this.apiKeys[this.currentKeyIndex];
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      if ((this.keyErrorCount.get(key) || 0) < this.maxConsecutiveErrors) return key;
      cycles++;
    }
    this.apiKeys.forEach(key => this.keyErrorCount.set(key, 0));
    return this.apiKeys[this.currentKeyIndex++ % this.apiKeys.length];
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
    this.keyErrorCount.set(apiKey, 0);
  }

  recordError(apiKey) {
    this.keyErrorCount.set(apiKey, (this.keyErrorCount.get(apiKey) || 0) + 1);
  }

  async fetchNews(maxRetries = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const apiKey = this.getRotationalApiKey();
      try {
        const articles = await this.makeNewsRequest(apiKey);
        this.recordSuccess(apiKey);
        return articles;
      } catch (error) {
        this.recordError(apiKey);
        lastError = error;
        if (attempt < maxRetries - 1) {
          await this.sleep(1500 * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  async makeNewsRequest(apiKey) {
    try {
      const response = await axios.get('https://newsapi.org/v2/top-headlines', {
        params: {
          country: 'us',
          pageSize: 30,
          apiKey: apiKey
        },
        timeout: 15000
      });
      if (!response.data.articles) throw new Error('No articles found');
      return response.data.articles;
    } catch (error) {
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatistics() {
    return {
      totalKeys: this.apiKeys.length,
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: key.substring(0, 8) + '...',
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    };
  }
}

module.exports = new NewsService();
