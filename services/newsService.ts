// narrative-backend/services/newsService.ts
import crypto from 'crypto';
import { z } from 'zod'; // Security: Input Validation
import KeyManager from '../utils/KeyManager';
import logger from '../utils/logger';
import apiClient from '../utils/apiClient';
import redisClient from '../utils/redisClient';
import config from '../utils/config';
import CircuitBreaker from '../utils/CircuitBreaker'; 
import { normalizeUrl } from '../utils/helpers';
import { INewsSourceArticle, INewsAPIResponse } from '../types';
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
  urlToImage: z.string().nullable().optional(), // NewsAPI variant
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
   * Uses Redis INCR to ensure multiple workers never clash on the same source.
   */
  private async getAndAdvanceCycleIndex(): Promise<number> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      
      if (redisClient.isReady()) {
          try {
              // Atomic Increment: Returns the NEW value immediately
              const newValue = await redisClient.incr(redisKey);
              
              // Wrap around using modulo
              const index = (newValue - 1) % FETCH_CYCLES.length;
              return index;
          } catch (e) { 
              logger.warn(`Redis Cycle Error: ${e}. Defaulting to 0.`);
              return 0; 
          }
      }
      
      // Fallback if Redis is down (Randomize to avoid stuck on same source)
      return Math.floor(Math.random() * FETCH_CYCLES.length);
  }

  async fetchNews(): Promise<INewsSourceArticle[]> {
    const allArticles: INewsSourceArticle[] = [];
    
    // 1. Atomic Cycle Selection
    const cycleIndex = await this.getAndAdvanceCycleIndex();
    const currentCycle = FETCH_CYCLES[cycleIndex];
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name} (Index: ${cycleIndex})`);

    let gnewsFailed = false;

    // 2. Try GNews First
    try {
        const gnewsArticles = await this.fetchFromGNews(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
        
        // Soft Failure Check: If GNews gives us junk (0 or 1 article), consider it failed
        if (gnewsArticles.length < 2) {
            logger.warn(`GNews returned low yield (${gnewsArticles.length}). Marking for fallback.`);
            gnewsFailed = true;
        }

    } catch (err: any) {
        logger.warn(`GNews fetch failed: ${err.message}`);
        gnewsFailed = true;
    }

    // 3. Fallback to NewsAPI (Triggered on Error OR Low Yield)
    if (allArticles.length < 5 || gnewsFailed) {
      const isNewsApiOpen = await CircuitBreaker.isOpen('NEWS_API');
      
      if (isNewsApiOpen) {
          logger.info('⚠️ Low yield/Error, triggering NewsAPI fallback...');
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
      }
    }

    // 4. REDIS LOCK: Filter Seen AND Lock Processing
    // Clears lock immediately on failure to allow retries
    const potentialNewArticles = await this.filterSeenOrProcessing(allArticles);

    // 5. DB CHECK: Filter articles already persisted
    const dbUnseenArticles = await this.filterExistingInDB(potentialNewArticles);

    // 6. PROCESS: Clean, Score, and Deduplicate (Fuzzy & Exact)
    const finalUnique = articleProcessor.processBatch(dbUnseenArticles);
    
    // 7. REDIS PERSIST: Mark accepted articles as "Seen"
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
    let blockedCount = 0;

    for (const article of articles) {
        const key = this.getRedisKey(article.url);
        
        try {
            // SET key "processing" Only If Not Exists (NX)
            const result = await client.set(key, 'processing', { 
                NX: true, 
                EX: 600 // 10 mins lock
            });

            if (result === 'OK') {
                unique.push(article);
            } else {
                blockedCount++;
            }
        } catch (e) {
            unique.push(article);
        }
    }

    if (blockedCount > 0) {
        logger.debug(`🚫 Redis blocked ${blockedCount} duplicates/processing articles.`);
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
                  // 48h TTL
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

  // --- API FETCHERS ---

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
          const response = await apiClient.get<unknown>(url, { params });
          KeyManager.reportSuccess(apiKey);

          // ZOD VALIDATION: Ensure response is valid structure
          const result = NewsApiResponseSchema.safeParse(response.data);

          if (!result.success) {
              logger.error(`${sourceName} Schema Mismatch: ${JSON.stringify(result.error.format())}`);
              return [];
          }
          
          const rawArticles = result.data.articles || [];
          if (rawArticles.length === 0) return [];

          return this.normalizeArticles(rawArticles, sourceName);

      } catch (error: any) {
          const status = error.response?.status;
          await KeyManager.reportFailure(apiKey, status === 429 || status === 403);
          throw error;
      }
  }

  private normalizeArticles(articles: any[], sourceName: string): INewsSourceArticle[] {
      return articles
        .filter(a => a.url) // Basic check: must have URL
        .map(a => ({
          source: { name: a.source?.name || sourceName },
          title: a.title || "", 
          description: a.description || a.content || "", 
          url: normalizeUrl(a.url!), // ! used because we filtered above 
          image: a.image || a.urlToImage, 
          publishedAt: a.publishedAt || new Date().toISOString()
      }));
  }
}

export default new NewsService();
