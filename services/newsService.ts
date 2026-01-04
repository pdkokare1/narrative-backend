// services/newsService.ts
import crypto from 'crypto';
import logger from '../utils/logger';
import redisClient from '../utils/redisClient';
import { INewsSourceArticle } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS } from '../utils/constants';

// Centralized processor
import articleProcessor from './articleProcessor';

// Strategies
import { GNewsProvider } from './news/GNewsProvider';

class NewsService {
  private gnews: GNewsProvider;

  constructor() {
    this.gnews = new GNewsProvider();
    logger.info(`📰 News Service Initialized with [GNews Only]`);
  }

  /**
   * ATOMIC CYCLE MANAGEMENT
   */
  private async getAndAdvanceCycleIndex(): Promise<number> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      
      if (redisClient.isReady()) {
          try {
              const newValue = await redisClient.incr(redisKey);
              // Reset periodically to prevent overflow
              if (newValue > 1000000) { 
                  await redisClient.set(redisKey, '0');
              }
              const length = FETCH_CYCLES.length || 1; 
              const index = Math.abs((newValue - 1) % length);
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
    
    // FIX 1: Broader Fetching
    // Fetch 2 different cycles per run to ensure we cover 'Top' and 'Categories' frequently
    // This prevents the feed from looking stale if we get stuck on a slow category.
    const CYCLES_TO_RUN = 2;

    for (let i = 0; i < CYCLES_TO_RUN; i++) {
        const cycleIndex = await this.getAndAdvanceCycleIndex();
        const currentCycle = FETCH_CYCLES[cycleIndex];
        
        logger.info(`🔄 News Fetch Cycle (${i+1}/${CYCLES_TO_RUN}): ${currentCycle.name}`);

        try {
            const gnewsArticles = await this.gnews.fetchArticles(currentCycle.gnews);
            if (gnewsArticles.length > 0) {
                allArticles.push(...gnewsArticles);
            }
        } catch (err: any) {
            logger.error(`❌ GNews fetch failed for ${currentCycle.name}: ${err.message}`);
        }
    }

    if (allArticles.length === 0) {
        logger.warn("❌ CRITICAL: No articles fetched from GNews in this run.");
        return [];
    }

    // 2. Processing Pipeline
    const potentialNewArticles = await this.filterSeenOrProcessing(allArticles);
    const dbUnseenArticles = await this.filterExistingInDB(potentialNewArticles);
    const finalUnique = articleProcessor.processBatch(dbUnseenArticles);
    
    // Mark as seen so we don't fetch them again immediately
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

    const checks = articles.map(async (article) => {
        const key = this.getRedisKey(article.url);
        try {
            // Set NX (Only if Not Exists) with 3 minute expiry (processing lock)
            const result = await client.set(key, 'processing', { NX: true, EX: 180 });
            return result === 'OK' ? article : null;
        } catch (e) {
            return article;
        }
    });

    const results = await Promise.all(checks);
    return results.filter((a): a is INewsSourceArticle => a !== null);
  }

  private async markAsSeenInRedis(articles: INewsSourceArticle[]) {
      if (articles.length === 0) return;
      const client = redisClient.getClient();
      if (client && redisClient.isReady()) {
          try {
              const multi = client.multi();
              for (const article of articles) {
                  const key = this.getRedisKey(article.url);
                  // FIX 2: Reduced TTL from 24h (86400) to 4h (14400)
                  // This allows "stuck" or failed articles to be retried much sooner
                  multi.set(key, '1', { EX: 14400 }); 
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
}

export default new NewsService();
