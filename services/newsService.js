// services/newsService.js (FINAL v2.5 - Focused News Fetching)
// --- *** FIX (2025-11-12 V6): Drastically reduced fetch limits to 2 per region to stay in free tier *** ---
const axios = require('axios');

// --- Helper Functions ---
function sleep(ms) { // Keep sleep available if needed later
    return new Promise(resolve => setTimeout(resolve, ms));
}

function removeDuplicatesByURL(articles) {
    if (!Array.isArray(articles)) return []; // Handle invalid input
    const seenUrls = new Set();
    return articles.filter(article => {
        if (!article || typeof article !== 'object' || !article.url || typeof article.url !== 'string') {
            // console.warn("⚠️ Skipping invalid article object during deduplication:", article);
            return false;
        }
        if (seenUrls.has(article.url)) {
            // console.log(`⏩ Skipping duplicate URL: ${article.url}`); // Verbose log
            return false;
        }
        seenUrls.add(article.url);
        return true;
    });
}

// --- NewsService Class ---
class NewsService {
  constructor() {
    this.gnewsKeys = this.loadApiKeys('GNEWS');
    this.newsapiKeys = this.loadApiKeys('NEWS_API'); // Corrected variable name
    this.currentGNewsIndex = 0;
    this.currentNewsAPIIndex = 0;
    this.keyUsageCount = new Map();
    this.keyErrorCount = new Map();

    // Initialize trackers for all loaded keys
    [...this.gnewsKeys, ...this.newsapiKeys].forEach(key => {
        if (key) { // Ensure key is not null/undefined
            this.keyUsageCount.set(key, 0);
            this.keyErrorCount.set(key, 0);
        }
    });
    console.log(`📰 News Service Initialized.`);
  }

  // Generic function to load keys for a specific provider
  loadApiKeys(providerPrefix) {
    const keys = [];
    // Check numbered keys (e.g., GNEWS_API_KEY_1)
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`${providerPrefix}_API_KEY_${i}`]?.trim();
      if (key) keys.push(key);
    }
    // Check for a default key (e.g., GNEWS_API_KEY)
    const defaultKey = process.env[`${providerPrefix}_API_KEY`]?.trim();
    if (keys.length === 0 && defaultKey) {
        keys.push(defaultKey);
        console.log(`🔑 Using default ${providerPrefix}_API_KEY.`);
    }

    if (keys.length === 0) console.warn(`⚠️ No ${providerPrefix} API keys found.`);
    else console.log(`🔑 Loaded ${keys.length} ${providerPrefix} API key(s).`);
    return keys;
  }

  // --- Key Rotation and Management ---
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

 recordSuccess(apiKey, apiName = "NewsAPI") {
    if (apiKey && this.keyUsageCount.has(apiKey)) {
        this.keyUsageCount.set(apiKey, (this.keyUsageCount.get(apiKey) || 0) + 1);
        if (this.keyErrorCount.get(apiKey) > 0) {
            this.keyErrorCount.set(apiKey, 0); // Reset errors on success
            // console.log(`✅ Error count reset for ${apiName} key ...${apiKey.slice(-4)}`);
        }
    }
}

recordError(apiKey, apiName = "NewsAPI") {
    if (apiKey && this.keyErrorCount.has(apiKey)) {
        const currentErrors = (this.keyErrorCount.get(apiKey) || 0) + 1;
        this.keyErrorCount.set(apiKey, currentErrors);
        console.warn(`📈 Error count for ${apiName} key ...${apiKey.slice(-4)} increased to ${currentErrors}`);
    } else if (apiKey) {
        console.warn(`📈 Attempted to record error for unknown ${apiName} key ...${apiKey.slice(-4)}`);
    } else {
        console.warn(`📈 Attempted to record error for ${apiName}, but API key was missing.`);
    }
}


  // --- Main Fetch Logic: Prioritize GNews, Fallback to NewsAPI ---
  async fetchNews() {
    let allArticles = [];
    let successfulSources = new Set();
    const startTime = Date.now();

    // --- *** THIS IS THE FIX *** ---
    // We are reducing the number of articles fetched to 2 per region.
    // This reduces the total from 30 to 6, which is extremely safe for the free tier.
    // --- *** END OF FIX *** ---

    // --- GNews Attempts ---
    if (this.gnewsKeys.length > 0) {
      console.log('📡 Fetching from GNews (US, IN, World)...');
      const gnewsRequests = [
        { params: { country: 'us', max: 2 }, name: 'GNews-US' }, // WAS 5
        { params: { country: 'in', max: 2 }, name: 'GNews-IN' }, // WAS 5
        { params: { topic: 'world', lang: 'en', max: 2 }, name: 'GNews-World' } // WAS 5
      ];

      // Execute requests concurrently
      const gnewsResults = await Promise.allSettled(
        gnewsRequests.map(req => this.fetchFromGNews(req.params, req.name))
      );

      // Process results
      gnewsResults.forEach((result, index) => {
        const reqName = gnewsRequests[index].name;
        if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
          console.log(`✅ ${reqName} successful: ${result.value.length} articles.`);
          allArticles.push(...result.value);
          successfulSources.add(reqName);
        } else if (result.status === 'fulfilled') {
          console.log(`🆗 ${reqName} returned 0 articles.`);
        } else { // status === 'rejected'
          console.error(`❌ ${reqName} failed: ${result.reason?.message || result.reason}`);
        }
      });
    } else {
      console.warn("⚠️ Skipping GNews fetch: No keys configured.");
    }


    // --- NewsAPI Fallback ---
    const needsNewsApiFallback = this.newsapiKeys.length > 0 && (this.gnewsKeys.length === 0 || allArticles.length < 3); // Trigger if GNews failed or returned few

    if (needsNewsApiFallback) {
      console.log('📡 GNews insufficient/unavailable. Fetching fallback from NewsAPI (US, IN, Geopolitics)...');
      const newsapiRequests = [
         { params: { country: 'us', pageSize: 2 }, name: 'NewsAPI-US', endpoint: 'top-headlines' }, // WAS 5
         { params: { country: 'in', pageSize: 2 }, name: 'NewsAPI-IN', endpoint: 'top-headlines' }, // WAS 5
         { params: { q: 'geopolitics OR "international relations" OR diplomacy', language: 'en', pageSize: 2, sortBy: 'publishedAt' }, name: 'NewsAPI-Geopolitics', endpoint: 'everything' } // WAS 5
      ];

      const newsapiResults = await Promise.allSettled(
        newsapiRequests.map(req => this.fetchFromNewsAPI(req.params, req.name, req.endpoint))
      );

      newsapiResults.forEach((result, index) => {
        const reqName = newsapiRequests[index].name;
        if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
          console.log(`✅ ${reqName} successful: ${result.value.length} articles.`);
          allArticles.push(...result.value);
          successfulSources.add(reqName);
        } else if (result.status === 'fulfilled') {
          console.log(`🆗 ${reqName} returned 0 articles.`);
        } else {
          console.error(`❌ ${reqName} fallback failed: ${result.reason?.message || result.reason}`);
        }
      });
    } else if (this.newsapiKeys.length > 0) {
      console.log('📡 Skipping NewsAPI fallback: GNews provided sufficient data or NewsAPI keys missing.');
    }

    // --- Deduplicate & Finalize ---
    const uniqueArticles = removeDuplicatesByURL(allArticles);
    uniqueArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // Sort by newest first

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    const sourceList = Array.from(successfulSources).join(', ') || 'None';

    console.log(`📰 FetchNews finished in ${duration}s. Sources contacted: [${sourceList}]. Found ${uniqueArticles.length} unique articles.`);

    if (uniqueArticles.length === 0 && successfulSources.size === 0) {
        if (this.gnewsKeys.length === 0 && this.newsapiKeys.length === 0) {
            console.error('❌ News fetching failed critically: No API keys configured for any provider.');
        } else {
           console.error('❌ News fetching failed critically: All attempted API calls failed or returned no data.');
        }
        return []; // Return empty array on critical failure
    }

    return uniqueArticles;
  }

  // --- GNews API Call Helper ---
  async fetchFromGNews(params, sourceName = "GNews") {
    const apiKey = this.getNextGNewsKey();
    // Use Promise.reject for consistency with Promise.allSettled
    if (!apiKey) return Promise.reject(new Error(`No GNews key available for ${sourceName}`));

    const defaultParams = { lang: 'en', sortby: 'publishedAt', max: 10 }; // Default max per request
    const requestParams = { ...defaultParams, ...params, apikey: apiKey };
    const url = 'https://gnews.io/api/v4/top-headlines';

    try {
      const response = await axios.get(url, { params: requestParams, timeout: 25000 }); // Increased timeout

      // Validate response structure
      if (!response?.data || !Array.isArray(response.data.articles)) {
        console.warn(`⚠️ ${sourceName} response missing 'articles' array.`);
        return []; // Treat as empty result, not error
      }
      if (response.data.articles.length === 0) return []; // Valid but empty result

      this.recordSuccess(apiKey, sourceName);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error) {
      this.recordError(apiKey, sourceName);
      const errorMsg = this.formatApiError(error, sourceName);
      return Promise.reject(new Error(errorMsg)); // Reject promise
    }
  }

  // --- NewsAPI Call Helper ---
  async fetchFromNewsAPI(params, sourceName = "NewsAPI", endpointType = 'top-headlines') {
      const apiKey = this.getNextNewsAPIKey();
      if (!apiKey) return Promise.reject(new Error(`No NewsAPI key available for ${sourceName}`));

      const defaultParams = { language: 'en', pageSize: 10 };
      const requestParams = { ...defaultParams, ...params, apiKey: apiKey };
      const baseUrl = 'https://newsapi.org/v2/';
      const endpoint = endpointType === 'everything' ? 'everything' : 'top-headlines';
      const url = baseUrl + endpoint;
       // Add sorting for 'everything' endpoint
      if(endpoint === 'everything' && !requestParams.sortBy) requestParams.sortBy = 'publishedAt';

      try {
          const response = await axios.get(url, { params: requestParams, timeout: 25000 }); // Increased timeout

         if (!response?.data || !Array.isArray(response.data.articles)) {
             console.warn(`⚠️ ${sourceName} response missing 'articles' array.`);
             return [];
         }
         if (response.data.articles.length === 0) return [];

          this.recordSuccess(apiKey, sourceName);
          return this.transformNewsAPIArticles(response.data.articles);

      } catch (error) {
          this.recordError(apiKey, sourceName);
          const errorMsg = this.formatApiError(error, sourceName);
          return Promise.reject(new Error(errorMsg)); // Reject promise
      }
  }

  // --- Error Formatting Helper ---
  formatApiError(error, apiName) {
      let msg = `${apiName} request failed: `;
      if (error.response) {
          msg += `Status ${error.response.status}`;
          const status = error.response.status;
          if (status === 401) msg += ' (Invalid API Key/Auth)';
          else if (status === 429) msg += ' (Rate Limit Exceeded)';
          else if (status === 403) msg += ' (Forbidden/Permissions Issue)';
          else if (status === 426 && apiName.includes('NewsAPI')) msg += ' (Upgrade Required - Free plan on live?)';
          else if (status >= 500) msg += ' (Server Error)';
          // Avoid logging full response data for brevity/security
          // msg += ` - Body: ${JSON.stringify(error.response.data)?.substring(0, 100)}...`;
      } else if (error.request) {
          msg += 'No response received (Network issue or timeout)';
      } else {
          msg += error.message; // Setup error
      }
      return msg;
  }

  // --- Article Transformers (with basic validation) ---
  transformGNewsArticles(articles) {
    if (!Array.isArray(articles)) return [];
    return articles
      .map(article => ({
        source: { name: article?.source?.name?.trim() || 'Unknown GNews Source' },
        title: article?.title?.trim() || null,
        description: (article?.description || article?.content)?.trim() || null,
        url: article?.url?.trim() || null,
        urlToImage: article?.image?.trim() || null,
        publishedAt: article?.publishedAt || new Date().toISOString(),
        content: article?.content?.trim() || ''
      }))
      .filter(a => a.url && a.title && a.description); // Ensure essentials are present
  }

  transformNewsAPIArticles(articles) {
     if (!Array.isArray(articles)) return [];
    return articles
      .map(article => ({
        source: { name: article?.source?.name?.trim() || 'Unknown NewsAPI Source' },
        title: article?.title?.trim() || null,
        description: article?.description?.trim() || null,
        url: article?.url?.trim() || null,
        urlToImage: article?.urlToImage?.trim() || null,
        publishedAt: article?.publishedAt || new Date().toISOString(), // Use ISOString
        content: article?.content?.trim() || ''
      }))
       .filter(a => a.url && a.title && a.description);
  }


  // --- Statistics ---
  getStatistics() {
    const loadedGKeys = this.gnewsKeys || [];
    const loadedNKeys = this.newsapiKeys || [];
    const allKeys = [...loadedGKeys, ...loadedNKeys];

    return {
      totalGNewsKeysLoaded: loadedGKeys.length,
      totalNewsAPIKeysLoaded: loadedNKeys.length,
      keyStatus: allKeys.map((key, index) => ({
        provider: loadedGKeys.includes(key) ? 'GNews' : 'NewsAPI',
        keyLast4: key ? `...${key.slice(-4)}` : 'N/A', // Handle null/undefined key if array loading failed
        usage: key ? (this.keyUsageCount.get(key) || 0) : 0,
        consecutiveErrors: key ? (this.keyErrorCount.get(key) || 0) : 0
      }))
    };
  }
}

module.exports = new NewsService();
