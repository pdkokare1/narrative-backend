// services/newsService.js (FINAL v3.2 - Centralized Key Manager)
const axios = require('axios');
const KeyManager = require('../utils/KeyManager'); // <--- NEW: Central Manager

// --- Helper Functions ---

// 1. Headline Formatter
function formatHeadline(title) {
    if (!title) return "No Title";
    let clean = title.trim();
    
    // Rule A: Force Uppercase start
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    
    // Rule B: Force Period at end (unless it ends in ? or !)
    if (!/[.!?]["']?$/.test(clean)) {
        clean += ".";
    }
    
    return clean;
}

// 2. URL Normalizer
function normalizeUrl(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source', 'fbclid', 'gclid'];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));
        return urlObj.toString();
    } catch (e) {
        return url; 
    }
}

// 3. Deduplication
function removeDuplicatesAndClean(articles) {
    if (!Array.isArray(articles)) return []; 
    const seenUrls = new Set();
    
    return articles.filter(article => {
        if (!article || typeof article !== 'object') return false;
        if (!article.title || !article.url) return false;
        if (article.title.length < 10) return false; 

        const cleanUrl = normalizeUrl(article.url);
        if (seenUrls.has(cleanUrl)) return false;
        
        seenUrls.add(cleanUrl);
        article.url = cleanUrl; 
        
        // APPLY FORMATTING HERE
        article.title = formatHeadline(article.title);
        
        return true;
    });
}

// --- NewsService Class ---
class NewsService {
  constructor() {
    // 1. Initialize Keys via Manager
    KeyManager.loadKeys('GNEWS', 'GNEWS');
    KeyManager.loadKeys('NEWS_API', 'NEWS_API');
    console.log(`堂 News Service Initialized`);
  }

  // --- Main Fetch Logic ---
  async fetchNews() {
    let allArticles = [];
    
    // 1. GNews Fetch (Try block ensures flow continues if GNews fails)
    try {
        console.log('藤 Fetching from GNews...');
        const gnewsRequests = [
            { params: { country: 'us', max: 15 }, name: 'GNews-US' }, 
            { params: { country: 'in', max: 15 }, name: 'GNews-IN' },
            { params: { topic: 'world', lang: 'en', max: 15 }, name: 'GNews-World' }
        ];

        const gnewsResults = await Promise.allSettled(
            gnewsRequests.map(req => this.fetchFromGNews(req.params, req.name))
        );

        gnewsResults.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.length > 0) {
            allArticles.push(...result.value);
            }
        });
    } catch (err) {
        console.warn("GNews fetch skipped/failed:", err.message);
    }

    // 2. NewsAPI Fallback
    // Only fetch if GNews didn't return enough articles
    const needsFallback = allArticles.length < 15;

    if (needsFallback) {
      console.log('藤 Fetching fallback from NewsAPI...');
      const newsapiRequests = [
         { params: { country: 'us', pageSize: 15 }, name: 'NewsAPI-US', endpoint: 'top-headlines' },
         { params: { country: 'in', pageSize: 15 }, name: 'NewsAPI-IN', endpoint: 'top-headlines' },
         { params: { q: 'politics', language: 'en', pageSize: 15, sortBy: 'publishedAt' }, name: 'NewsAPI-Politics', endpoint: 'everything' }
      ];

      const newsapiResults = await Promise.allSettled(
        newsapiRequests.map(req => this.fetchFromNewsAPI(req.params, req.name, req.endpoint))
      );

      newsapiResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allArticles.push(...result.value);
        }
      });
    }

    // 3. Clean & Deduplicate
    const uniqueArticles = removeDuplicatesAndClean(allArticles);
    uniqueArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return uniqueArticles;
  }

  // --- GNews Call ---
  async fetchFromGNews(params, sourceName) {
    let apiKey = '';
    try {
        apiKey = KeyManager.getKey('GNEWS');
    } catch (e) {
        return Promise.reject(new Error("No GNews Keys available"));
    }

    const url = 'https://gnews.io/api/v4/top-headlines';
    try {
      const response = await axios.get(url, { 
          params: { lang: 'en', sortby: 'publishedAt', max: 10, ...params, apikey: apiKey }, 
          timeout: 20000 
      });

      if (!response.data?.articles?.length) return [];
      
      KeyManager.reportSuccess(apiKey);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error) {
      // 429 = Too Many Requests, 403 = Forbidden (Quota or Invalid)
      const isRateLimit = error.response?.status === 429 || error.response?.status === 403;
      KeyManager.reportFailure(apiKey, isRateLimit);
      return Promise.reject(error);
    }
  }

  // --- NewsAPI Call ---
  async fetchFromNewsAPI(params, sourceName, endpointType) {
      let apiKey = '';
      try {
          apiKey = KeyManager.getKey('NEWS_API');
      } catch (e) {
          return Promise.reject(new Error("No NewsAPI Keys available"));
      }

      const url = `https://newsapi.org/v2/${endpointType}`;
      try {
          const response = await axios.get(url, { 
              params: { language: 'en', pageSize: 10, ...params, apiKey: apiKey }, 
              timeout: 20000 
          });

         if (!response.data?.articles?.length) return [];
         
         KeyManager.reportSuccess(apiKey);
         return this.transformNewsAPIArticles(response.data.articles);

      } catch (error) {
          // 429 = Too Many Requests
          const isRateLimit = error.response?.status === 429;
          KeyManager.reportFailure(apiKey, isRateLimit);
          return Promise.reject(error);
      }
  }

  // --- Transformers (Unchanged) ---
  transformGNewsArticles(articles) {
    if (!Array.isArray(articles)) return [];
    return articles.map(article => ({
        source: { name: article?.source?.name?.trim() || 'GNews Source' },
        title: article?.title?.trim(),
        description: (article?.description || article?.content)?.trim(),
        url: article?.url?.trim(),
        urlToImage: article?.image?.trim(),
        publishedAt: article?.publishedAt || new Date().toISOString()
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
        publishedAt: article?.publishedAt || new Date().toISOString()
    }));
  }
}

module.exports = new NewsService();
