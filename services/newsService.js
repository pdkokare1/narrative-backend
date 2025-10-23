// services/newsService.js (Updated for News Focus)
const axios = require('axios');

// Helper to remove duplicate articles by URL
function removeDuplicatesByURL(articles) {
    const seenUrls = new Set();
    return articles.filter(article => {
        if (!article || !article.url || seenUrls.has(article.url)) {
            return false;
        }
        seenUrls.add(article.url);
        return true;
    });
}

class NewsService {
  constructor() {
    this.gnewsKeys = this.loadGNewsKeys();
    this.newsapiKeys = this.loadNewsAPIKeys();
    this.currentGNewsIndex = 0;
    this.currentNewsAPIIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize tracking
    [...this.gnewsKeys, ...this.newsapiKeys].forEach(key => {
      this.keyUsageCount.set(key, 0);
      this.keyErrorCount.set(key, 0);
    });

    console.log(`📰 GNews keys loaded: ${this.gnewsKeys.length}`);
    console.log(`📰 NewsAPI keys loaded: ${this.newsapiKeys.length}`);
  }

  loadGNewsKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GNEWS_API_KEY_${i}`];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.GNEWS_API_KEY) keys.push(process.env.GNEWS_API_KEY);
    console.log(`🔑 Loaded ${keys.length} GNews API keys.`);
    return keys;
  }

  loadNewsAPIKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`NEWS_API_KEY_${i}`];
      if (key) keys.push(key);
    }
    if (keys.length === 0 && process.env.NEWS_API_KEY) keys.push(process.env.NEWS_API_KEY);
    console.log(`🔑 Loaded ${keys.length} NewsAPI API keys.`);
    return keys;
  }

  getNextGNewsKey() {
    if (this.gnewsKeys.length === 0) return null;
    const key = this.gnewsKeys[this.currentGNewsIndex];
    this.currentGNewsIndex = (this.currentGNewsIndex + 1) % this.gnewsKeys.length;
    // console.log(`🔄 Using GNews Key index: ${this.currentGNewsIndex}`); // Debugging
    return key;
  }

  getNextNewsAPIKey() {
    if (this.newsapiKeys.length === 0) return null;
    const key = this.newsapiKeys[this.currentNewsAPIIndex];
    this.currentNewsAPIIndex = (this.currentNewsAPIIndex + 1) % this.newsapiKeys.length;
    // console.log(`🔄 Using NewsAPI Key index: ${this.currentNewsAPIIndex}`); // Debugging
    return key;
  }

  recordSuccess(apiKey) {
    this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
    this.keyErrorCount.set(apiKey, 0); // Reset errors on success
  }

  recordError(apiKey) {
    const newErrorCount = (this.keyErrorCount.get(apiKey) || 0) + 1;
    this.keyErrorCount.set(apiKey, newErrorCount);
     console.warn(`📈 Increased error count for key ending ...${apiKey.slice(-4)} to ${newErrorCount}`);
  }

  // --- UPDATED FETCHNEWS LOGIC ---
  async fetchNews() {
    let allArticles = [];
    let sourcesAttempted = [];

    // Prioritize GNews
    if (this.gnewsKeys.length > 0) {
      console.log('📡 Attempting GNews API calls (US, IN, World)...');
      try {
        // Fetch US Top Headlines
        const usArticles = await this.fetchFromGNews({ country: 'us', max: 20 }); // Limit calls slightly
        if (usArticles) {
            allArticles.push(...usArticles);
            sourcesAttempted.push('GNews-US');
            console.log(`✅ GNews US success: ${usArticles.length} articles`);
        }

        // Fetch India Top Headlines
        const inArticles = await this.fetchFromGNews({ country: 'in', max: 20 });
         if (inArticles) {
            allArticles.push(...inArticles);
            sourcesAttempted.push('GNews-IN');
            console.log(`✅ GNews IN success: ${inArticles.length} articles`);
        }

        // Fetch World (Geopolitical) Headlines
        const worldArticles = await this.fetchFromGNews({ topic: 'world', max: 20 });
         if (worldArticles) {
            allArticles.push(...worldArticles);
            sourcesAttempted.push('GNews-World');
            console.log(`✅ GNews World success: ${worldArticles.length} articles`);
        }

      } catch (err) {
        console.error(' GNews failed during multi-fetch:', err.message);
        // Continue to NewsAPI if GNews had issues
      }
    }

    // Fallback to NewsAPI if GNews failed completely or yielded few results
    if (this.newsapiKeys.length > 0 && allArticles.length < 15) { // Only fallback if GNews results are low
      console.log('📡 Attempting NewsAPI (fallback)...');
      try {
        // NewsAPI calls (Note: Free tier usually only works on localhost)
        const newsApiArticlesUS = await this.fetchFromNewsAPI({ country: 'us', pageSize: 15 });
        if (newsApiArticlesUS) {
            allArticles.push(...newsApiArticlesUS);
            sourcesAttempted.push('NewsAPI-US');
            console.log(`✅ NewsAPI US success: ${newsApiArticlesUS.length} articles`);
        }
         const newsApiArticlesIN = await this.fetchFromNewsAPI({ country: 'in', pageSize: 15 });
        if (newsApiArticlesIN) {
            allArticles.push(...newsApiArticlesIN);
            sourcesAttempted.push('NewsAPI-IN');
            console.log(`✅ NewsAPI IN success: ${newsApiArticlesIN.length} articles`);
        }
        // Maybe a general query for geopolitics
         const newsApiArticlesWorld = await this.fetchFromNewsAPI({ q: 'geopolitics OR international relations', language: 'en', pageSize: 10 });
         if (newsApiArticlesWorld) {
             allArticles.push(...newsApiArticlesWorld);
             sourcesAttempted.push('NewsAPI-World');
             console.log(`✅ NewsAPI World success: ${newsApiArticlesWorld.length} articles`);
         }

      } catch (err) {
        console.error(' NewsAPI fallback failed:', err.message);
      }
    }

    // Remove duplicates before returning
    const uniqueArticles = removeDuplicatesByURL(allArticles);
    console.log(`📰 Total unique articles fetched from [${sourcesAttempted.join(', ')}]: ${uniqueArticles.length}`);

    if (uniqueArticles.length === 0 && sourcesAttempted.length === 0) {
      throw new Error('All news APIs failed or no keys configured.');
    } else if (uniqueArticles.length === 0) {
       console.warn('⚠️ No unique articles found after fetching from available sources.');
    }

    return uniqueArticles;
  }

  // --- UPDATED GNEWS FUNCTION ---
  async fetchFromGNews(params) {
    const apiKey = this.getNextGNewsKey();
    if (!apiKey) {
        console.warn('⚠️ No GNews API key available for this request.');
        return null; // Don't throw, just return null so multi-fetch can continue
    }

    const defaultParams = {
        lang: 'en', // Prefer English
        sortby: 'publishedAt',
        max: 10 // Default limit per call
    };

    const requestParams = { ...defaultParams, ...params, apikey: apiKey };
    const queryDescription = params.country ? `country=${params.country}` : `topic=${params.topic}`; // For logging

    try {
      // console.log(`📡 GNews Request (${queryDescription}):`, requestParams); // Debugging
      const response = await axios.get('https://gnews.io/api/v4/top-headlines', {
        params: requestParams,
        timeout: 15000 // 15 second timeout
      });

      if (!response.data || !response.data.articles || response.data.articles.length === 0) {
        console.warn(`⚠️ GNews (${queryDescription}) returned no articles or invalid structure.`);
        // Don't record error for empty results, but don't record success either
        return []; // Return empty array, not null
      }

      this.recordSuccess(apiKey);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error) {
      this.recordError(apiKey);
      let errorMsg = ` GNews request (${queryDescription}) failed: ${error.message}`;
      if (error.response) {
        errorMsg += ` (Status: ${error.response.status})`;
        if (error.response.status === 401) errorMsg += ' - Invalid API Key?';
        if (error.response.status === 429) errorMsg += ' - Rate Limit Exceeded?';
      }
      console.error(errorMsg);
      // Don't re-throw, let the multi-fetch continue if possible
      return null;
    }
  }

  // --- UPDATED NEWSAPI FUNCTION (Handles params better) ---
  async fetchFromNewsAPI(params) {
      const apiKey = this.getNextNewsAPIKey();
      if (!apiKey) {
          console.warn('⚠️ No NewsAPI key available for this request.');
          return null;
      }

       const defaultParams = {
            language: 'en',
            pageSize: 10 // Default limit per call
       };

        const requestParams = { ...defaultParams, ...params, apiKey: apiKey };
        const queryDescription = params.country ? `country=${params.country}` : `q=${params.q}`; // For logging


      try {
          // console.log(`📡 NewsAPI Request (${queryDescription}):`, requestParams); // Debugging
          const response = await axios.get('https://newsapi.org/v2/top-headlines', { // Still uses top-headlines endpoint
              params: requestParams,
              timeout: 15000
          });

          if (!response.data || !response.data.articles || response.data.articles.length === 0) {
                console.warn(`⚠️ NewsAPI (${queryDescription}) returned no articles or invalid structure.`);
                return [];
          }

          this.recordSuccess(apiKey);
          return this.transformNewsAPIArticles(response.data.articles);

      } catch (error) {
          this.recordError(apiKey);
          let errorMsg = ` NewsAPI request (${queryDescription}) failed: ${error.message}`;
          if (error.response) {
            errorMsg += ` (Status: ${error.response.status})`;
             if (error.response.status === 401) errorMsg += ' - Invalid API Key / Not localhost?';
             if (error.response.status === 429) errorMsg += ' - Rate Limit Exceeded?';
          }
           console.error(errorMsg);
           return null;
      }
  }


  // --- TRANSFORMERS (No changes needed) ---
  transformGNewsArticles(articles) {
    return articles
      .map(article => ({
        source: {
          name: article.source?.name || 'Unknown GNews Source' // Safer access
        },
        title: article.title || 'No Title Provided',
        description: article.description || article.content || 'No description available',
        url: article.url || null, // Set to null if missing
        urlToImage: article.image || null,
        publishedAt: article.publishedAt || new Date().toISOString(),
        content: article.content || ''
      }))
      .filter(article => article.url && article.title && article.description); // Filter out articles missing essential info
  }

  transformNewsAPIArticles(articles) {
    return articles
      .map(article => ({
        source: {
          name: article.source?.name || 'Unknown NewsAPI Source' // Safer access
        },
        title: article.title || 'No Title Provided',
        description: article.description || 'No description available',
        url: article.url || null, // Set to null if missing
        urlToImage: article.urlToImage || null,
        publishedAt: article.publishedAt || new Date().toISOString(),
        content: article.content || ''
      }))
       .filter(article => article.url && article.title && article.description); // Filter out articles missing essential info
  }

  getStatistics() {
    return {
      totalGNewsKeys: this.gnewsKeys.length,
      totalNewsAPIKeys: this.newsapiKeys.length,
      keyUsage: Array.from(this.keyUsageCount.entries()).map(([key, count]) => ({
        key: `...${key.slice(-4)}`, // Show only last 4 chars
        usage: count,
        errors: this.keyErrorCount.get(key) || 0
      }))
    };
  }
}

module.exports = new NewsService();
