// services/newsService.ts
import crypto from 'crypto';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import redisClient from '../utils/redisClient';
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS } from '../utils/constants';

class NewsService {
  constructor() {
    KeyManager.loadKeys('GNEWS', 'GNEWS');
    KeyManager.loadKeys('NEWS_API', 'NEWS_API');
    logger.info(`📰 News Service Initialized`);
  }

  /**
   * Retrieves the current cycle index from Redis to ensure rotation persists
   * across server restarts.
   */
  private async getNextCycle() {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      let index = 0;

      // @ts-ignore
      if (redisClient.isReady()) {
          try {
              const stored = await redisClient.get(redisKey);
              const current = stored ? parseInt(stored, 10) : 0;
              index = (current + 1) % FETCH_CYCLES.length;
              await redisClient.set(redisKey, index.toString(), 86400); 
          } catch (e) {
              logger.warn(`Redis Cycle Fetch Error, defaulting to 0: ${e}`);
          }
      }

      return FETCH_CYCLES[index];
  }

  async fetchNews(): Promise<INewsSourceArticle[]> {
    const allArticles: INewsSourceArticle[] = [];
    const currentCycle = await this.getNextCycle();
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name}`);

    // 1. Try GNews First
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

    // 3. Clean and Deduplicate
    const cleaned = this.removeDuplicatesAndClean(allArticles);

    // 4. Redis "Bouncer" Check
    const redisFiltered = await this.filterSeenInRedis(cleaned);
    
    // 5. Database Deduplication
    const finalUnique = await this.filterExistingInDB(redisFiltered);

    // 6. Mark accepted articles as "Seen" in Redis
    await this.markAsSeenInRedis(finalUnique);

    logger.info(`✅ Fetched & Cleaned: ${finalUnique.length} new articles (from ${allArticles.length} raw)`);
    return finalUnique;
  }

  // --- REDIS HELPERS ---

  private getRedisKey(url: string): string {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `news:seen:${hash}`;
  }

  private async filterSeenInRedis(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
    if (articles.length === 0) return [];
    
    const unseen: INewsSourceArticle[] = [];
    let skippedCount = 0;

    for (const article of articles) {
        const key = this.getRedisKey(article.url);
        const isSeen = await redisClient.get(key);
        
        if (isSeen) {
            skippedCount++;
        } else {
            unseen.push(article);
        }
    }

    if (skippedCount > 0) {
        logger.info(`🚫 Redis blocked ${skippedCount} duplicate articles.`);
    }
    
    return unseen;
  }

  private async markAsSeenInRedis(articles: INewsSourceArticle[]) {
      for (const article of articles) {
          const key = this.getRedisKey(article.url);
          await redisClient.set(key, '1', 172800); // 48 hours
      }
  }

  // --- DB HELPERS ---

  private async filterExistingInDB(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
      if (articles.length === 0) return [];
      
      const urls = articles.map(a => a.url);
      const existingDocs = await Article.find({ url: { $in: urls } }).select('url').lean();
      const existingUrls = new Set(existingDocs.map((d: any) => d.url));
      
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
          await KeyManager.reportFailure(apiKey, status === 429 || status === 403);
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
