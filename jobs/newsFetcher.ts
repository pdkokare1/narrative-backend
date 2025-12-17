// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import pipelineService from '../services/pipelineService';
import logger from '../utils/logger'; 

// --- 1. Fetch Logic (Producer) ---
// This function only gets the raw data. It does NOT process it.
async function fetchFeed() {
  logger.info('🔄 Job Started: Fetching news feed...');
  
  try {
    const rawArticles = await newsService.fetchNews(); 
    
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return []; 
    }

    logger.info(`📡 Fetched ${rawArticles.length} articles. Preparing to dispatch...`);
    return rawArticles;

  } catch (error: any) {
    logger.error(`❌ Fetch Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

// --- 2. Process Logic (Consumer) ---
// This function handles ONE article at a time.
// If this fails, only this specific article is retried by the queue.
async function processArticleJob(article: any) {
    try {
        const result = await pipelineService.processSingleArticle(article);
        return result;
    } catch (error: any) {
        logger.error(`⚠️ Pipeline Error for "${article.title}": ${error.message}`);
        throw error; // Throwing error tells BullMQ to retry this specific job
    }
}

export default { fetchFeed, processArticleJob };
