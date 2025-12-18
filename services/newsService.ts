// services/newsService.ts
import crypto from 'crypto';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import redisClient from '../utils/redisClient';
import config from '../utils/config';
import CircuitBreaker from '../utils/CircuitBreaker'; 
import { cleanText, formatHeadline, normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS, TRUSTED_SOURCES, JUNK_KEYWORDS } from '../utils/constants';

class NewsService {
  constructor() {
    // Initialize Keys from Central Config
    KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    KeyManager.registerProviderKeys('NEWS_API', config.keys.newsApi);
    logger.info(`📰 News Service Initialized`);
  }

  /**
   * Retrieves the current cycle index from Redis.
   */
  private async getCycleIndex(): Promise<number> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      if (redisClient.isReady()) {
          try {
              const stored = await redisClient.get(redisKey);
              return stored ? parseInt(stored, 10) : 0;
          } catch (e) {
              return 0;
          }
      }
      return 0;
  }

  /**
   * Advances the cycle index to the next one (Round Robin)
   */
  private async advanceCycle(): Promise<void> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      const current = await this.getCycleIndex();
      const next = (current + 1) % FETCH_CYCLES.length;
      
      if (redisClient.isReady()) {
         await redisClient.set(redisKey, next.toString(), 86400);
      }
      logger.info(`🔄 Advancing News Cycle to Index: ${next}`);
  }

  async fetchNews(): Promise<INewsSourceArticle[]> {
    const allArticles: INewsSourceArticle[] = [];
    
    // Get current config
    const cycleIndex = await this.getCycleIndex();
    const currentCycle = FETCH_CYCLES[cycleIndex];
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name} (Index: ${cycleIndex})`);

    // 1. Try GNews First (Primary)
    try {
        const gnewsArticles = await this.fetchFromGNews(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
    } catch (err: any) {
        logger.warn(`GNews fetch failed: ${err.message}`);
        
        // IMMEDIATE RETRY LOGIC: If we hit a Rate Limit (429), advance cycle immediately
        if (err.response?.status === 429) {
            logger.warn("⚠️ GNews Limit Reached. Advancing cycle for next run.");
            await this.advanceCycle();
        }
    }

    // 2. Fallback to NewsAPI (Secondary with Circuit Breaker)
    if (allArticles.length < 5) {
      const isNewsApiOpen = await CircuitBreaker.isOpen('NEWS_API');
      
      if (isNewsApiOpen) {
          logger.info('⚠️ Low yield from GNews, triggering NewsAPI fallback...');
          try {
              const newsApiArticles = await this.fetchFromNewsAPI(currentCycle.newsapi);
              allArticles.push(...newsApiArticles);
              await CircuitBreaker.recordSuccess('NEWS_API');
          } catch (err: any) {
              logger.warn(`NewsAPI fallback failed: ${err.message}`);
              if (err.response?.status === 429) {
                   await CircuitBreaker.recordFailure('NEWS_API');
              }
          }
      } else {
          logger.warn('🚫 NewsAPI Circuit Breaker is OPEN. Skipping fallback.');
      }
    }

    // 3. Early Redis "Bouncer" Check (Cheap & Fast)
    const potentialNewArticles = await this.filterSeenInRedis(allArticles);

    // 4. Clean, Score, and Deduplicate (CPU Intensive)
    const cleaned = this.removeDuplicatesAndClean(potentialNewArticles);
    
    // 5. Database Deduplication (Disk I/O)
    const finalUnique = await this.filterExistingInDB(cleaned);

    // 6. Mark accepted articles as "Seen" in Redis
    await this.markAsSeenInRedis(finalUnique);

    // 7. Auto-Advance Cycle if we are cycling through categories
    // (Optional: Only if you want to rotate topics every fetch)
    await this.advanceCycle();

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
    const keys = articles.map(a => this.getRedisKey(a.url)); 
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
      const existingDocs = await Article.find({ url: { $in: urls } }).select('url').lean();
      const existingUrls = new Set(existingDocs.map((d: any) => d.url));
      
      return articles.filter(a => !existingUrls.has(a.url));
  }

  private async fetchFromGNews(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('GNEWS');
    const queryParams = { lang: 'en', sortby: 'publishedAt', max: CONSTANTS.NEWS.FETCH_LIMIT, ...params, apikey: apiKey };
    return this.fetchExternal('https://gnews.io/api/v4/top-headlines', queryParams, apiKey, 'GNews');
  }

  private async fetchFromNewsAPI(params: any): Promise<INewsSourceArticle[]> {
    const apiKey = await KeyManager.getKey('NEWS_API');
    const endpoint = params.q ? 'everything' : 'top-headlines'; 
    const queryParams = { pageSize: CONSTANTS.NEWS.FETCH_LIMIT, ...params, apiKey: apiKey };
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
          title: a.title || "", // Raw title
          description: a.description || a.content || "", // Raw description
          url: normalizeUrl(a.url), 
          image: a.image || a.urlToImage, 
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }

  /**
   * ENHANCED SCORING & DEDUPLICATION
   */
  private removeDuplicatesAndClean(articles: INewsSourceArticle[]): INewsSourceArticle[] {
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    
    const scoredArticles = articles.map(a => {
        let score = 0;
        const titleLower = (a.title || "").toLowerCase();
        const sourceLower = (a.source.name || "").toLowerCase();

        // 1. Image Signal (+2)
        if (a.image && a.image.startsWith('http')) score += 2;

        // 2. Length Signal (+1)
        if (a.title && a.title.length > 40) score += 1;

        // 3. Trusted Source Signal (+3)
        if (TRUSTED_SOURCES.some(src => sourceLower.includes(src))) {
            score += 3;
        }

        // 4. Junk/Clickbait Penalty (-5)
        if (JUNK_KEYWORDS.some(word => titleLower.includes(word))) {
            score -= 5;
        }

        return { article: a, score };
    }).sort((a, b) => b.score - a.score); // Sort highest score first

    const uniqueArticles: INewsSourceArticle[] = [];

    for (const item of scoredArticles) {
        const article = item.article;

        if (item.score < 0) continue;

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
