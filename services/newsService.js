// services/newsService.js (FINAL v3.0 - Deduplication & Normalization)
const axios = require('axios');

// --- Helper Functions ---

// Strip tracking parameters to ensure unique URLs
function normalizeUrl(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        // Remove common tracking parameters
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source', 'fbclid', 'gclid'];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));
        return urlObj.toString();
    } catch (e) {
        return url; // Return original if parsing fails
    }
}

function removeDuplicatesAndClean(articles) {
    if (!Array.isArray(articles)) return []; 
    const seenUrls = new Set();
    
    return articles.filter(article => {
        // 1. Basic Validation
        if (!article || typeof article !== 'object') return false;
        if (!article.title || !article.url) return false;
        
        // 2. Junk Filter (Skip articles with no image or very short titles)
        // Note: For GNews/NewsAPI, sometimes image is null, we can allow it if title is good.
        // But for a visual feed, we prefer images. Let's be lenient but prefer quality.
        if (article.title.length < 10) return false; 

        // 3. Normalization & Deduplication
        const cleanUrl = normalizeUrl(article.url);
        if (seenUrls.has(cleanUrl)) return false;
        
        seenUrls.add(cleanUrl);
        // Update the article URL to the clean version
        article.url = cleanUrl; 
        return true;
    });
}

// --- NewsService Class ---
class NewsService {
  constructor() {
    this.gnewsKeys = this.loadApiKeys('GNEWS');
    this.newsapiKeys = this.loadApiKeys('NEWS_API'); 
    this.currentGNewsIndex = 0;
    this.currentNewsAPIIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize trackers
    [...this.gnewsKeys, ...this.newsapiKeys].forEach(key => {
        if (key) {
            this.keyUsageCount.set(key, 0);
            this.keyErrorCount.set(key, 0);
        }
    });
    console.log(`📰 News Service Initialized.`);
  }

  loadApiKeys(providerPrefix) {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`${providerPrefix}_API_KEY_${i}`]?.trim();
      if (key) keys.push(key);
    }
    const defaultKey = process.env[`${providerPrefix}_API_KEY`]?.trim();
    if (keys.length === 0 && defaultKey) keys.push(defaultKey);

    if (keys.length === 0) console.warn(`⚠️ No ${providerPrefix} API keys found.`);
    else console.log(`🔑 Loaded ${keys.length} ${providerPrefix} API key(s).`);
    return keys;
  }

  // --- Key Rotation ---
  getNextKey(keys, currentIndex) {
      if (!keys || keys.length === 0) return { key: null, nextIndex: 0 };
      const key = keys[currentIndex];
      const nextIndex = (currentIndex + 1) % keys.length;
      return { key, nextIndex };
  }

  getNextGNewsKey() {
      const { key, nextIndex } = this.getNextKey(this.gnewsKeys, this.currentGNewsIndex);
      this.currentGNewsIndex = nextIndex;
      return key;
  }

  getNextNewsAPIKey() {
      const { key, nextIndex } = this.getNextKey(this.newsapiKeys, this.currentNewsAPIIndex);
      this.currentNewsAPIIndex = nextIndex;
      return key;
  }

  recordSuccess(apiKey) {
    if (apiKey && this.keyUsageCount.has(apiKey)) {
        this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
        this.keyErrorCount.set(apiKey, 0); 
    }
  }

  recordError(apiKey, apiName = "NewsAPI") {
    if (apiKey && this.keyErrorCount.has(apiKey)) {
        const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
        this.keyErrorCount.set(apiKey, currentErrors);
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} increased to ${currentErrors}`);
    }
  }

  // --- Main Fetch Logic ---
  async fetchNews() {
    let allArticles = [];
    let successfulSources = new Set();
    const startTime = Date.now();

    // 1. GNews Fetch (Primary)
    if (this.gnewsKeys.length > 0) {
      console.log('📡 Fetching from GNews...');
      const gnewsRequests = [
        { params: { country: 'us', max: 15 }, name: 'GNews-US' }, 
        { params: { country: 'in', max: 15 }, name: 'GNews-IN' },
        { params: { topic: 'world', lang: 'en', max: 15 }, name: 'GNews-World' }
      ];

      const gnewsResults = await Promise.allSettled(
        gnewsRequests.map(req => this.fetchFromGNews(req.params, req.name))
      );

      gnewsResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allArticles.push(...result.value);
          successfulSources.add(gnewsRequests[index].name);
        }
      });
    }

    // 2. NewsAPI Fallback (Secondary)
    const needsFallback = this.newsapiKeys.length > 0 && (this.gnewsKeys.length === 0 || allArticles.length < 15);

    if (needsFallback) {
      console.log('📡 Fetching fallback from NewsAPI...');
      const newsapiRequests = [
         { params: { country: 'us', pageSize: 15 }, name: 'NewsAPI-US', endpoint: 'top-headlines' },
         { params: { country: 'in', pageSize: 15 }, name: 'NewsAPI-IN', endpoint: 'top-headlines' },
         { params: { q: 'politics', language: 'en', pageSize: 15, sortBy: 'publishedAt' }, name: 'NewsAPI-Politics', endpoint: 'everything' }
      ];

      const newsapiResults = await Promise.allSettled(
        newsapiRequests.map(req => this.fetchFromNewsAPI(req.params, req.name, req.endpoint))
      );

      newsapiResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allArticles.push(...result.value);
          successfulSources.add(newsapiRequests[index].name);
        }
      });
    }

    // 3. Clean & Deduplicate
    const uniqueArticles = removeDuplicatesAndClean(allArticles);
    
    // Sort by date (newest first)
    uniqueArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📰 FetchNews finished in ${duration}s. Found ${uniqueArticles.length} unique articles.`);

    return uniqueArticles;
  }

  // --- GNews Call ---
  async fetchFromGNews(params, sourceName) {
    const apiKey = this.getNextGNewsKey();
    if (!apiKey) return Promise.reject(new Error("No GNews Key"));

    const url = 'https://gnews.io/api/v4/top-headlines';
    try {
      const response = await axios.get(url, { 
          params: { lang: 'en', sortby: 'publishedAt', max: 10, ...params, apikey: apiKey }, 
          timeout: 20000 
      });

      if (!response.data?.articles?.length) return [];
      this.recordSuccess(apiKey);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error) {
      this.recordError(apiKey, sourceName);
      return Promise.reject(error);
    }
  }

  // --- NewsAPI Call ---
  async fetchFromNewsAPI(params, sourceName, endpointType) {
      const apiKey = this.getNextNewsAPIKey();
      if (!apiKey) return Promise.reject(new Error("No NewsAPI Key"));

      const url = `https://newsapi.org/v2/${endpointType}`;
      try {
          const response = await axios.get(url, { 
              params: { language: 'en', pageSize: 10, ...params, apiKey: apiKey }, 
              timeout: 20000 
          });

         if (!response.data?.articles?.length) return [];
         this.recordSuccess(apiKey);
         return this.transformNewsAPIArticles(response.data.articles);

      } catch (error) {
          this.recordError(apiKey, sourceName);
          return Promise.reject(error);
      }
  }

  // --- Transformers ---
  transformGNewsArticles(articles) {
    if (!Array.isArray(articles)) return [];
    return articles.map(article => ({
        source: { name: article?.source?.name?.trim() || 'GNews Source' },
        title: article?.title?.trim(),
        description: (article?.description || article?.content)?.trim(),
        url: article?.url?.trim(),
        urlToImage: article?.image?.trim(),
        publishedAt: article?.publishedAt || new Date().toISOString(),
        content: article?.content?.trim() || ''
    }));
  }

  transformNewsAPIArticles(articles) {
     if (!Array.isArray(articles)) return [];
    return articles.map(article => ({
        source: { name: article?.source?.name?.trim() || 'NewsAPI Source' },
        title: article?.title?.trim(),
        description: article?.description?.trim(),
        url: article?.url?.trim(),
        urlToImage: article?.urlToImage?.trim(),
        publishedAt: article?.publishedAt || new Date().toISOString(),
        content: article?.content?.trim() || ''
    }));
  }

  getStatistics() {
    return {
      totalGNewsKeys: this.gnewsKeys.length,
      totalNewsAPIKeys: this.newsapiKeys.length
    };
  }
}

module.exports = new NewsService();
