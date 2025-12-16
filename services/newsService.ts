// services/newsService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';

interface IRawArticle {
    source: { name: string };
    title: string;
    description: string;
    content?: string;
    url: string;
    image?: string;
    urlToImage?: string;
    publishedAt: string;
}

function removeDuplicatesAndClean(articles: any[]): any[] {
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
        article.title = formatHeadline(article.title);
        
        return true;
    });
}

class NewsService {
  constructor() {
    KeyManager.loadKeys('GNEWS', 'GNEWS');
    KeyManager.loadKeys('NEWS_API', 'NEWS_API');
    logger.info(`📰 News Service Initialized`);
  }

  async fetchNews(): Promise<any[]> {
    const allArticles: any[] = [];
    
    // 1. GNews Fetch
    try {
        logger.info('📡 Fetching from GNews...');
        const gnewsRequests = [
            { params: { country: 'us', max: 15 }, name: 'GNews-US' }, 
            { params: { country: 'in', max: 15 }, name: 'GNews-IN' },
            { params: { topic: 'world', lang: 'en', max: 15 }, name: 'GNews-World' }
        ];

        const gnewsResults = await Promise.allSettled(
            gnewsRequests.map(req => this.fetchFromGNews(req.params))
        );

        gnewsResults.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.length > 0) {
                allArticles.push(...result.value);
            }
        });
    } catch (err: any) {
        logger.warn(`GNews fetch skipped/failed: ${err.message}`);
    }

    // 2. NewsAPI Fallback (Only if GNews results are low)
    if (allArticles.length < 15) {
      logger.info('📡 Fetching fallback from NewsAPI...');
      const newsapiRequests = [
         { params: { country: 'us', pageSize: 15 }, endpoint: 'top-headlines' },
         { params: { country: 'in', pageSize: 15 }, endpoint: 'top-headlines' },
         { params: { q: 'politics', language: 'en', pageSize: 15, sortBy: 'publishedAt' }, endpoint: 'everything' }
      ];

      const newsapiResults = await Promise.allSettled(
        newsapiRequests.map(req => this.fetchFromNewsAPI(req.params, req.endpoint))
      );

      newsapiResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allArticles.push(...result.value);
        }
      });
    }

    const uniqueArticles = removeDuplicatesAndClean(allArticles);
    uniqueArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    return uniqueArticles;
  }

  async fetchFromGNews(params: any): Promise<any[]> {
    let apiKey = '';
    try {
        apiKey = await KeyManager.getKey('GNEWS');
    } catch (e) {
        return Promise.reject(new Error("No GNews Keys available"));
    }

    const url = 'https://gnews.io/api/v4/top-headlines';
    try {
      // Updated: Use apiClient
      const response = await apiClient.get(url, { 
          params: { lang: 'en', sortby: 'publishedAt', max: 10, ...params, apikey: apiKey }
      });

      if (!response.data?.articles?.length) return [];
      
      KeyManager.reportSuccess(apiKey);
      return this.transformGNewsArticles(response.data.articles);

    } catch (error: any) {
      const isRateLimit = error.response?.status === 429 || error.response?.status === 403;
      await KeyManager.reportFailure(apiKey, isRateLimit);
      return Promise.reject(error);
    }
  }

  async fetchFromNewsAPI(params: any, endpointType: string): Promise<any[]> {
      let apiKey = '';
      try {
          apiKey = await KeyManager.getKey('NEWS_API');
      } catch (e) {
          return Promise.reject(new Error("No NewsAPI Keys available"));
      }

      const url = `https://newsapi.org/v2/${endpointType}`;
      try {
          // Updated: Use apiClient
          const response = await apiClient.get(url, { 
              params: { language: 'en', pageSize: 10, ...params, apiKey: apiKey }
          });

         if (!response.data?.articles?.length) return [];
         
         KeyManager.reportSuccess(apiKey);
         return this.transformNewsAPIArticles(response.data.articles);

      } catch (error: any) {
          const isRateLimit = error.response?.status === 429;
          await KeyManager.reportFailure(apiKey, isRateLimit);
          return Promise.reject(error);
      }
  }

  transformGNewsArticles(articles: IRawArticle[]) {
    if (!Array.isArray(articles)) return [];
    return articles.map(article => ({
        source: { name: article?.source?.name?.trim() || 'GNews Source' },
        title: article?.title?.trim(),
        // Updated: Use cleanText helper
        description: cleanText(article?.description || article?.content || ""),
        url: article?.url?.trim(),
        urlToImage: article?.image?.trim(),
        publishedAt: article?.publishedAt || new Date().toISOString()
    }));
  }

  transformNewsAPIArticles(articles: IRawArticle[]) {
     if (!Array.isArray(articles)) return [];
    return articles.map(article => ({
        source: { name: article?.source?.name?.trim() || 'NewsAPI Source' },
        title: article?.title?.trim(),
        // Updated: Use cleanText helper
        description: cleanText(article?.description || ""),
        url: article?.url?.trim(),
        urlToImage: article?.urlToImage?.trim(),
        publishedAt: article?.publishedAt || new Date().toISOString()
    }));
  }
}

export = new NewsService();
