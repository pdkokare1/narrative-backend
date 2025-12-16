// services/newsService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';

// Rotation cycles to save API quota
const FETCH_CYCLES = [
    { name: 'US-Focus', gnews: { country: 'us' }, newsapi: { country: 'us' } },
    { name: 'IN-Focus', gnews: { country: 'in' }, newsapi: { country: 'in' } },
    { name: 'World-Focus', gnews: { topic: 'world' }, newsapi: { q: 'international', language: 'en' } }
];

let currentCycleIndex = 0;

class NewsService {
  constructor() {
    KeyManager.loadKeys('GNEWS', 'GNEWS');
    KeyManager.loadKeys('NEWS_API', 'NEWS_API');
    logger.info(`📰 News Service Initialized`);
  }

  // Rotate to the next region for the next run
  private getNextCycle() {
    const cycle = FETCH_CYCLES[currentCycleIndex];
    currentCycleIndex = (currentCycleIndex + 1) % FETCH_CYCLES.length;
    return cycle;
  }

  async fetchNews(): Promise<INewsSourceArticle[]> {
    const allArticles: INewsSourceArticle[] = [];
    const currentCycle = this.getNextCycle();
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name}`);

    // 1. Try GNews First (Preferred Source)
    try {
        const gnewsArticles = await this.fetchFromGNews(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
    } catch (err: any) {
        logger.warn(`GNews fetch failed: ${err.message}`);
    }

    // 2. Fallback to NewsAPI ONLY if GNews gave us very little
    if (allArticles.length < 5) {
      logger.info('⚠️ Low yield from GNews, triggering NewsAPI fallback...');
      try {
          const newsApiArticles = await this.fetchFromNewsAPI(currentCycle.newsapi);
          allArticles.push(...newsApiArticles);
      } catch (err: any) {
          logger.warn(`NewsAPI fallback failed: ${err.message}`);
      }
    }

    const cleaned = this.removeDuplicatesAndClean(allArticles);
    logger.info(`✅ Fetched & Cleaned: ${cleaned.length} articles`);
    return cleaned;
  }

  private async fetchFromGNews(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('GNEWS');
    // GNews allows joining params, but we keep it simple for now
    const queryParams = { lang: 'en', sortby: 'publishedAt', max: 10, ...params, apikey: apiKey };
    
    return this.fetchExternal('https://gnews.io/api/v4/top-headlines', queryParams, apiKey, 'GNews');
  }

  private async fetchFromNewsAPI(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('NEWS_API');
    const endpoint = params.q ? 'everything' : 'top-headlines'; // 'q' means we use /everything endpoint
    const queryParams = { pageSize: 10, ...params, apiKey: apiKey };

    return this.fetchExternal(`https://newsapi.org/v2/${endpoint}`, queryParams, apiKey, 'NewsAPI');
  }

  // Centralized fetcher to reduce code duplication
  private async fetchExternal(url: string, params: any, apiKey: string, sourceName: string): Promise<INewsSourceArticle[]> {
      try {
          const response = await apiClient.get<INewsAPIResponse>(url, { params });
          
          if (!response.data?.articles?.length) return [];

          KeyManager.reportSuccess(apiKey);
          return this.normalizeArticles(response.data.articles, sourceName);

      } catch (error: any) {
          const status = error.response?.status;
          const isRateLimit = status === 429 || status === 403;
          await KeyManager.reportFailure(apiKey, isRateLimit);
          throw error;
      }
  }

  private normalizeArticles(articles: any[], sourceName: string): INewsSourceArticle[] {
      return articles.map(a => ({
          source: { name: a.source?.name || sourceName },
          title: formatHeadline(a.title || ""),
          description: cleanText(a.description || a.content || ""),
          url: normalizeUrl(a.url),
          image: a.image || a.urlToImage, // Unify GNews 'image' and NewsAPI 'urlToImage'
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }

  private removeDuplicatesAndClean(articles: INewsSourceArticle[]): INewsSourceArticle[] {
    const seenUrls = new Set<string>();
    
    return articles.filter(article => {
        if (!article.title || !article.url) return false;
        if (article.title.length < 10) return false; // Skip broken titles

        const url = article.url;
        if (seenUrls.has(url)) return false;
        
        seenUrls.add(url);
        return true;
    }).sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }
}

export default new NewsService();
