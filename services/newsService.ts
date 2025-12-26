// narrative-backend/services/newsService.ts
import crypto from 'crypto';
import logger from '../utils/logger';
import redisClient from '../utils/redisClient';
import CircuitBreaker from '../utils/CircuitBreaker'; 
import { INewsSourceArticle } from '../types';
import Article from '../models/articleModel';
import { FETCH_CYCLES, CONSTANTS } from '../utils/constants';

// Centralized processor
import articleProcessor from './articleProcessor';

// Strategies
import { GNewsProvider } from './news/GNewsProvider';
import { NewsApiProvider } from './news/NewsApiProvider';

class NewsService {
  private gnews: GNewsProvider;
  private newsapi: NewsApiProvider;

  constructor() {
    this.gnews = new GNewsProvider();
    this.newsapi = new NewsApiProvider();
    logger.info(`📰 News Service Initialized with [GNews, NewsAPI]`);
  }

  /**
   * ATOMIC CYCLE MANAGEMENT
   */
  private async getAndAdvanceCycleIndex(): Promise<number> {
      const redisKey = CONSTANTS.REDIS_KEYS.NEWS_CYCLE;
      
      if (redisClient.isReady()) {
          try {
              const newValue = await redisClient.incr(redisKey);
              // Reset periodically to prevent overflow (though unlikely in Redis)
              if (newValue > 1000000) { 
                  await redisClient.set(redisKey, '0');
              }
              // Safety: Ensure FETCH_CYCLES has length to avoid division by zero
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
    const cycleIndex = await this.getAndAdvanceCycleIndex();
    const currentCycle = FETCH_CYCLES[cycleIndex];
    
    logger.info(`🔄 News Fetch Cycle: ${currentCycle.name} (Index: ${cycleIndex})`);

    let gnewsFailed = false;

    // 1. Try GNews Strategy
    try {
        const gnewsArticles = await this.gnews.fetchArticles(currentCycle.gnews);
        allArticles.push(...gnewsArticles);
        
        // Critical: Increased threshold to trigger backup more aggressively if yield is low
        if (gnewsArticles.length < 5) {
            logger.warn(`GNews returned low yield (${gnewsArticles.length}). Marking for fallback.`);
            gnewsFailed = true;
        }
    } catch (err: any) {
        logger.warn(`GNews fetch failed: ${err.message}`);
        gnewsFailed = true;
    }

    // 2. Fallback to NewsAPI Strategy
    // Fixed: Logic now runs fallback if GNews failed OR had low results.
    // Removed strict CircuitBreaker.isOpen check to ensure we always try backup if needed.
    if (allArticles.length < 5 || gnewsFailed) {
      logger.info('⚠️ Low yield/Error, triggering NewsAPI fallback...');
      try {
          const newsApiArticles = await this.newsapi.fetchArticles(currentCycle.newsapi);
          if (newsApiArticles.length > 0) {
              logger.info(`✅ NewsAPI Backup retrieved ${newsApiArticles.length} articles.`);
              allArticles.push(...newsApiArticles);
              await CircuitBreaker.recordSuccess('NEWS_API');
          } else {
              logger.warn('NewsAPI returned 0 articles.');
          }
      } catch (err: any) {
          logger.warn(`NewsAPI fallback failed: ${err.message}`);
          await CircuitBreaker.recordFailure('NEWS_API');
      }
    }

    // 3. Processing Pipeline
    // Filter -> Check DB -> Process -> Cache
    if (allArticles.length === 0) {
        logger.warn("❌ CRITICAL: No articles fetched from any source this cycle.");
        return [];
    }

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
                  // Fixed: Reduced from 48h to 24h to allow re-reporting of evolving stories
                  multi.set(key, '1', { EX: 86400 }); 
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
