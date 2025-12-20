// narrative-backend/services/newsService.ts
import crypto from 'crypto';
import { z } from 'zod';
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import redisClient from '../utils/redisClient';
import config from '../utils/config';
import CircuitBreaker from '../utils/CircuitBreaker'; 
import { normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS } from '../utils/constants';

// Centralized processor
import articleProcessor from './articleProcessor';

// --- ZOD SCHEMAS FOR API VALIDATION ---
const SourceSchema = z.object({
  name: z.string().optional(),
  id: z.string().nullable().optional()
});

const ArticleSchema = z.object({
  source: SourceSchema.optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  url: z.string().url(),
  image: z.string().nullable().optional(),
  urlToImage: z.string().nullable().optional(),
  publishedAt: z.string().optional()
});

const NewsApiResponseSchema = z.object({
  status: z.string().optional(),
  totalResults: z.number().optional(),
  articles: z.array(ArticleSchema).optional()
});

class NewsService {
  constructor() {
    KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    KeyManager.registerProviderKeys('NEWS_API', config.keys.newsApi);
    logger.info(`📰 News Service Initialized`);
  }

  /**
   * ATOMIC CYCLE MANAGEMENT
   */
  private async getAndAdvanceCycleIndex(): Promise<number> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      
      if (redisClient.isReady()) {
          try {
              const newValue = await redisClient.incr(redisKey);
              const index = Math.abs((newValue - 1) % FETCH_CYCLES.length);
              return index;
          } catch (e) { 
              logger.warn(`Redis Cycle Error: ${e}. Defaulting to 0.`);
              return 0; 
          }
      }
      return Math.floor(Math.random() * FETCH_CYCLES.length);
  }

  async fetchNews(): Promise<INewsSourceArticle[]> {
    const allArticles: INewsSourceArticle[] = [];
    const cycleIndex = await this.getAndAdvanceCycleIndex();
    const currentCycle = FETCH_CYCLES[cycleIndex];
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name} (Index: ${cycleIndex})`);

    let gnewsFailed = false;

    // 2. Try GNews First (With Auto-Retry)
    try {
        const gnewsArticles = await this.fetchFromGNews(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
        
        if (gnewsArticles.length < 2) {
            logger.warn(`GNews returned low yield (${gnewsArticles.length}). Marking for fallback.`);
            gnewsFailed = true;
        }
    } catch (err: any) {
        logger.warn(`GNews fetch failed after retries: ${err.message}`);
        gnewsFailed = true;
    }

    // 3. Fallback to NewsAPI
    if (allArticles.length < 5 || gnewsFailed) {
      const isNewsApiOpen = await CircuitBreaker.isOpen('NEWS_API');
      
      if (isNewsApiOpen) {
          logger.info('⚠️ Low yield/Error, triggering NewsAPI fallback...');
          try {
              const newsApiArticles = await this.fetchFromNewsAPI(currentCycle.newsapi);
              allArticles.push(...newsApiArticles);
              await CircuitBreaker.recordSuccess('NEWS_API');
          } catch (err: any) {
              logger.warn(`NewsAPI fallback failed after retries: ${err.message}`);
              await CircuitBreaker.recordFailure('NEWS_API');
          }
      }
    }

    // 4. Processing Pipeline
    const potentialNewArticles = await this.filterSeenOrProcessing(allArticles);
    const dbUnseenArticles = await this.filterExistingInDB(potentialNewArticles);
    const finalUnique = articleProcessor.processBatch(dbUnseenArticles);
    await this.markAsSeenInRedis(finalUnique);

    logger.info(`✅ Fetched & Cleaned: ${finalUnique.length} new articles (from ${allArticles.length} raw)`);
    return finalUnique;
  }

  // --- REDIS HELPERS ---

  private getRedisKey(url: string): string {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `${CONSTANTS.REDIS_KEYS.NEWS_SEEN_PREFIX}${hash}`;
  }

  private async filterSeenOrProcessing(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
    if (articles.length === 0) return [];
    if (!redisClient.isReady()) return articles; 

    const client = redisClient.getClient();
    if (!client) return articles;

    const unique: INewsSourceArticle[] = [];
    
    for (const article of articles) {
        const key = this.getRedisKey(article.url);
        try {
            const result = await client.set(key, 'processing', { NX: true, EX: 180 });
            if (result === 'OK') unique.push(article);
        } catch (e) {
            unique.push(article);
        }
    }
    return unique;
  }

  private async markAsSeenInRedis(articles: INewsSourceArticle[]) {
      if (articles.length === 0) return;
      const client = redisClient.getClient();
      if (client && redisClient.isReady()) {
          try {
              const multi = client.multi();
              for (const article of articles) {
                  const key = this.getRedisKey(article.url);
                  multi.set(key, '1', { EX: 172800 }); 
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

  // --- API FETCHERS (REFACTORED) ---

  private async fetchFromGNews(params: any): Promise<INewsSourceArticle[]> {
    return KeyManager.executeWithRetry<INewsSourceArticle[]>('GNEWS', async (apiKey) => {
        const queryParams = { lang: 'en', sortby: 'publishedAt', max: CONSTANTS.NEWS.FETCH_LIMIT, ...params, apikey: apiKey };
        const url = 'https://gnews.io/api/v4/top-headlines';
        
        const response = await apiClient.get<unknown>(url, { params: queryParams });
        return this.validateAndNormalize(response.data, 'GNews');
    });
  }

  private async fetchFromNewsAPI(params: any): Promise<INewsSourceArticle[]> {
    return KeyManager.executeWithRetry<INewsSourceArticle[]>('NEWS_API', async (apiKey) => {
        const endpoint = params.q ? 'everything' : 'top-headlines';
        const queryParams = { pageSize: CONSTANTS.NEWS.FETCH_LIMIT, ...params, apiKey: apiKey };
        const url = `https://newsapi.org/v2/${endpoint}`;
        
        const response = await apiClient.get<unknown>(url, { params: queryParams });
        return this.validateAndNormalize(response.data, 'NewsAPI');
    });
  }

  // Pure Helper: No network logic, just parsing
  private validateAndNormalize(responseData: any, sourceName: string): INewsSourceArticle[] {
      const result = NewsApiResponseSchema.safeParse(responseData);

      if (!result.success) {
          logger.error(`${sourceName} Schema Mismatch: ${JSON.stringify(result.error.format())}`);
          return [];
      }

      const rawArticles = result.data.articles || [];
      return rawArticles
        .filter(a => a.url)
        .map(a => ({
          source: { name: a.source?.name || sourceName },
          title: a.title || "", 
          description: a.description || a.content || "", 
          url: normalizeUrl(a.url!), 
          // FIX: Added '|| undefined' to handle nulls strictly
          image: a.image || a.urlToImage || undefined, 
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }
}

export default new NewsService();
