// services/newsService.ts
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';
import Article from '../models/articleModel'; // Imported to check for duplicates

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

    // 3. Clean and Deduplicate (In-Memory)
    const cleaned = this.removeDuplicatesAndClean(allArticles);
    
    // 4. Database Deduplication (Check against history)
    const finalUnique = await this.filterExistingInDB(cleaned);

    logger.info(`✅ Fetched & Cleaned: ${finalUnique.length} new articles (from ${allArticles.length} raw)`);
    return finalUnique;
  }

  // NEW: Check Database for existing URLs to prevent duplicates
  private async filterExistingInDB(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
      if (articles.length === 0) return [];
      
      const urls = articles.map(a => a.url);
      
      // Find which of these URLs already exist in Mongo
      const existingDocs = await Article.find({ url: { $in: urls } }).select('url').lean();
      const existingUrls = new Set(existingDocs.map(d => d.url));
      
      // Only keep the ones NOT in the set
      return articles.filter(a => !existingUrls.has(a.url));
  }

  private async fetchFromGNews(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('GNEWS');
    const queryParams = { lang: 'en', sortby: 'publishedAt', max: 10, ...params, apikey: apiKey };
    
    return this.fetchExternal('https://gnews.io/api/v4/top-headlines', queryParams, apiKey, 'GNews');
  }

  private async fetchFromNewsAPI(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('NEWS_API');
    const endpoint = params.q ? 'everything' : 'top-headlines'; 
    const queryParams = { pageSize: 10, ...params, apiKey: apiKey };

    return this.fetchExternal(`https://newsapi.org/v2/${endpoint}`, queryParams, apiKey, 'NewsAPI');
  }

  private async fetchExternal(url: string, params: any, apiKey: string, sourceName: string): Promise<INewsSourceArticle[]> {
      try {
          const response = await apiClient.get<INewsAPIResponse>(url, { params });
          
          KeyManager.reportSuccess(apiKey);

          if (!response.data?.articles?.length) return [];
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
          image: a.image || a.urlToImage, 
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }

  private removeDuplicatesAndClean(articles: INewsSourceArticle[]): INewsSourceArticle[] {
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    
    // Sort by Quality Score first
    const scoredArticles = articles.map(a => {
        let score = 0;
        if (a.image && a.image.startsWith('http')) score += 2;
        if (a.title && a.title.length > 40) score += 1;
        return { article: a, score };
    }).sort((a, b) => b.score - a.score);

    const uniqueArticles: INewsSourceArticle[] = [];

    for (const item of scoredArticles) {
        const article = item.article;

        if (!article.title || !article.url) continue;
        
        if (article.title.length < 10) continue; 
        if (article.title === "No Title") continue;

        const url = article.url;
        if (seenUrls.has(url)) continue;

        const cleanTitle = article.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seenTitles.has(cleanTitle)) continue;
        
        seenUrls.add(url);
        seenTitles.add(cleanTitle);
        uniqueArticles.push(article);
    }

    return uniqueArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }
}

export default new NewsService();
