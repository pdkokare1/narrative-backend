const axios = require('axios');

class NewsService {
  constructor() {
    this.gnewsKeys = this.loadGNewsKeys();
    this.newsapiKeys = this.loadNewsAPIKeys();
    this.currentGNewsIndex = 0;
    this.currentNewsAPIIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize tracking
    this.gnewsKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });
    this.newsapiKeys.forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });

    console.log(`📰 GNews keys loaded: ${this.gnewsKeys.length}`);
    console.log(`📰 NewsAPI keys loaded: ${this.newsapiKeys.length}`);
  }

  loadGNewsKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env['GNEWS_API_KEY_' + i];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.GNEWS_API_KEY) {
      keys.push(process.env.GNEWS_API_KEY);
    }
    return keys;
  }

  loadNewsAPIKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env['NEWS_API_KEY_' + i];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.NEWS_API_KEY) {
      keys.push(process.env.NEWS_API_KEY);
    }
    return keys;
  }

  getNextGNewsKey() {
    if (this.gnewsKeys.length === 0) return null;
    const key = this.gnewsKeys[this.currentGNewsIndex];
    this.currentGNewsIndex = (this.currentGNewsIndex + 1) % this.gnewsKeys.length;
    return key;
  }

  getNextNewsAPIKey() {
    if (this.newsapiKeys.length === 0) return null;
    const key = this.newsapiKeys[this.currentNewsAPIIndex];
    this.currentNewsAPIIndex = (this.currentNewsAPIIndex + 1) % this.newsapiKeys.length;
    return key;
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
  }

  recordError(apiKey) {
    this.keyErrorCount.set(apiKey, (this.keyErrorCount.get(apiKey) || 0) + 1);
  }

  async fetchNews() {
    // Try GNews first (works on servers)
    if (this.gnewsKeys.length > 0) {
      try {
        console.log('📡 Attempting GNews API...');
        const articles = await this.fetchFromGNews();
        if (articles && articles.length > 0) {
          console.log(`✅ GNews success: ${articles.length} articles`);
          return articles;
        }
      } catch (err) {
        console.error('GNews failed:', err.message);
      }
    }

    // Fallback to NewsAPI if GNews fails
    if (this.newsapiKeys.length > 0) {
      try {
        console.log('📡 Attempting NewsAPI (fallback)...');
        const articles = await this.fetchFromNewsAPI();
        if (articles && articles.length > 0) {
          console.log(`✅ NewsAPI success: ${articles.length} articles`);
          return articles;
        }
      } catch (err) {
        console.error('NewsAPI failed:', err.message);
      }
    }

    // All APIs failed
    throw new Error('All news APIs failed. Configure at least one API key.');
  }

  async fetchFromGNews() {
    const apiKey = this.getNextGNewsKey();
    if (!apiKey) throw new Error('No GNews API key available');

    try {
      const response = await axios.get('https://gnews.io/api/v4/top-headlines', {
        params: {
          country: 'us',
          max: 50,
          apikey: apiKey,
          sortby: 'publishedAt'
        },
        timeout: 15000
      });

      if (!response.data || !response.data.articles) {
        throw new Error('Invalid GNews response structure');
      }

      this.recordSuccess(apiKey);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error) {
      this.recordError(apiKey);
      if (error.response && error.response.status === 401) {
        throw new Error('GNews API key invalid (401)');
      }
      throw error;
    }
  }

  async fetchFromNewsAPI() {
    const apiKey = this.getNextNewsAPIKey();
    if (!apiKey) throw new Error('No NewsAPI key available');

    try {
      const response = await axios.get('https://newsapi.org/v2/top-headlines', {
        params: {
          country: 'us',
          pageSize: 50,
          apiKey: apiKey
        },
        timeout: 15000
      });

      if (!response.data || !response.data.articles) {
        throw new Error('Invalid NewsAPI response structure');
      }

      this.recordSuccess(apiKey);
      return this.transformNewsAPIArticles(response.data.articles);

    } catch (error) {
      this.recordError(apiKey);
      if (error.response && error.response.status === 401) {
        throw new Error('NewsAPI key invalid (401) - Works only on localhost');
      }
      throw error;
    }
  }

  transformGNewsArticles(articles) {
    return articles.map(article => ({
      source: {
        name: article.source.name || 'GNews Source'
      },
      title: article.title || 'No title',
      description: article.description || article.content || 'No description',
      url: article.url || '',
      urlToImage: article.image || null,
      publishedAt: article.publishedAt || new Date().toISOString(),
      content: article.content || ''
    }));
  }

  transformNewsAPIArticles(articles) {
    return articles.map(article => ({
      source: {
        name: article.source.name || 'News Source'
      },
      title: article.title || 'No title',
      description: article.description || 'No description',
      url: article.url || '',
      urlToImage: article.urlToImage || null,
      publishedAt: article.publishedAt || new Date().toISOString(),
      content: article.content || ''
    }));
  }

  // --- THIS IS THE FIXED FUNCTION ---
  getStatistics() {
    return {
      totalGNewsKeys: this.gnewsKeys.length,
      totalNewsAPIKeys: this.newsapiKeys.length,
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: key.substring(0, 10) + '...',
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    };
  }
} // <-- This bracket was missing or part of the broken code

module.exports = new NewsService();
