// services/newsService.ts
import crypto from 'crypto';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import redisClient from '../utils/redisClient';
import config from '../utils/config';
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS } from '../utils/constants';

class NewsService {
  constructor() {
    // Initialize Keys from Central Config
    KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    KeyManager.registerProviderKeys('NEWS_API', config.keys.newsApi);
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

    // 1. Try GNews First (Primary)
    try {
        const gnewsArticles = await this.fetchFromGNews(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
    } catch (err: any) {
        logger.warn(`GNews fetch failed: ${err.message}`);
    }

    // 2. Fallback to NewsAPI (Secondary with Circuit Breaker)
    if (allArticles.length < 5) {
      const isNewsApiOpen = await this.checkCircuitBreaker('NEWS_API');
      
      if (isNewsApiOpen) {
          logger.info('⚠️ Low yield from GNews, triggering NewsAPI fallback...');
          try {
              const newsApiArticles = await this.fetchFromNewsAPI(currentCycle.newsapi);
              allArticles.push(...newsApiArticles);
              // If successful, reset any failure counts
              await this.resetCircuitBreaker('NEWS_API');
          } catch (err: any) {
              logger.warn(`NewsAPI fallback failed: ${err.message}`);
              await this.recordFailure('NEWS_API');
          }
      } else {
          logger.warn('🚫 NewsAPI Circuit Breaker is OPEN. Skipping fallback to protect system.');
      }
    }

    // --- NEW OPTIMIZATION ORDER ---
    
    // 3. Early Redis "Bouncer" Check (Cheap & Fast)
    // We check against Redis BEFORE doing heavy text cleaning/regex
    const potentialNewArticles = await this.filterSeenInRedis(allArticles);

    // 4. Clean and Deduplicate (CPU Intensive)
    // Only clean articles that passed the Redis check
    const cleaned = this.removeDuplicatesAndClean(potentialNewArticles);
    
    // 5. Database Deduplication (Disk I/O)
    // Final check against persistent storage
    const finalUnique = await this.filterExistingInDB(cleaned);

    // 6. Mark accepted articles as "Seen" in Redis
    await this.markAsSeenInRedis(finalUnique);

    logger.info(`✅ Fetched & Cleaned: ${finalUnique.length} new articles (from ${allArticles.length} raw)`);
    return finalUnique;
  }

  // --- CIRCUIT BREAKER HELPERS ---

  private async checkCircuitBreaker(provider: string): Promise<boolean> {
      if (!redisClient.isReady()) return true;
      const key = `breaker:open:${provider}`;
      const isOpen = await redisClient.get(key);
      return !isOpen; // If key exists, breaker is open (BLOCKED). If null, it's closed (ALLOWED).
  }

  private async recordFailure(provider: string) {
      if (!redisClient.isReady()) return;
      const failKey = `breaker:fail:${provider}`;
      const openKey = `breaker:open:${provider}`;

      // Increment failure count
      const count = await redisClient.incr(failKey);
      
      // Set a short expiry for the failure counter (window of 10 mins)
      if (count === 1) await redisClient.expire(failKey, 600);

      // If > 3 failures in 10 mins, OPEN THE BREAKER for 30 mins
      if (count >= 3) {
          logger.error(`🔥 ${provider} is failing repeatedly. Opening Circuit Breaker for 30 mins.`);
          await redisClient.set(openKey, '1', 1800); // 1800 seconds = 30 mins
          await redisClient.del(failKey); // Reset counter
      }
  }

  private async resetCircuitBreaker(provider: string) {
      if (!redisClient.isReady()) return;
      await redisClient.del(`breaker:fail:${provider}`);
  }

  // --- REDIS HELPERS ---

  private getRedisKey(url: string): string {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `news:seen:${hash}`;
  }

  private async filterSeenInRedis(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
    if (articles.length === 0) return [];
    
    const unseen: INewsSourceArticle[] = [];
    const keys = articles.map(a => this.getRedisKey(a.url)); // URL is already normalized by fetchExternal
    const results = await redisClient.mGet(keys);
    
    let skippedCount = 0;

    for (let i = 0; i < articles.length; i++) {
        // If result is null/undefined, it's not in Redis (Unseen)
        if (!results[i]) {
            unseen.push(articles[i]);
        } else {
            skippedCount++;
        }
    }

    if (skippedCount > 0) {
        logger.info(`🚫 Redis blocked ${skippedCount} duplicate articles.`);
    }
    
    return unseen;
  }

  private async markAsSeenInRedis(articles: INewsSourceArticle[]) {
      if (articles.length === 0) return;

      const client = redisClient.getClient();
      
      if (client && redisClient.isReady()) {
          try {
              const multi = client.multi();
              for (const article of articles) {
                  const key = this.getRedisKey(article.url);
                  multi.set(key, '1', { EX: 172800 }); // 48 hours
              }
              await multi.exec();
          } catch (e: any) {
              logger.error(`Redis Pipeline Error: ${e.message}`);
          }
      }
  }

  // --- DB HELPERS ---

  private async filterExistingInDB(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
      if (articles.length === 0) return [];
      
      const urls = articles.map(a => a.url);
      // Optimized: Only fetch the _id is enough, but we use url to compare
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
      // NOTE: We do MINIMAL processing here just to get the URL for Redis checking
      return articles.map(a => ({
          source: { name: a.source?.name || sourceName },
          title: a.title || "", // Raw title
          description: a.description || a.content || "", // Raw description
          url: normalizeUrl(a.url), // IMPORTANT: Normalize URL here so Redis check is valid
          image: a.image || a.urlToImage, 
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }

  private removeDuplicatesAndClean(articles: INewsSourceArticle[]): INewsSourceArticle[] {
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    
    // Simple heuristic scoring to prefer "better" looking articles
    const scoredArticles = articles.map(a => {
        let score = 0;
        if (a.image && a.image.startsWith('http')) score += 2;
        if (a.title && a.title.length > 40) score += 1;
        return { article: a, score };
    }).sort((a, b) => b.score - a.score);

    const uniqueArticles: INewsSourceArticle[] = [];

    for (const item of scoredArticles) {
        const article = item.article;

        // Apply cleaning logic HERE, after Redis check passed
        article.title = formatHeadline(article.title);
        article.description = cleanText(article.description || "");

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
